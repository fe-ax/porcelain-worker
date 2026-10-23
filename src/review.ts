import { anthropicRequest, MODEL, webSearchTool } from "./claude";
import { errorResponse, logAttempt, readCapped, defaultDeps, type PipelineDeps } from "./pipeline";
import { reviewSystemPrompt, reviewUserText } from "./prompts";
import { validateReviewBody, validateReviewIdBody } from "./validate";
import { HttpError, LIMITS, type DeviceRow, type Env, type ErrorBody } from "./types";

// Day review (WIRE.md "Day review"): /v1/review, /v1/review/status, /v1/review/cancel. The app sends structured data;
// the Worker owns the prompt and the Message Batches round trips (create, poll, continue on pause_turn, cancel).
// Every route is signed exactly like /v1/status: headers, device, assertion, counter, nonce, approved device.

type Endpoint = "review" | "review_status" | "review_cancel";

const BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const CUSTOM_ID = "day-review";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const countryOf = (request: Request): string | null =>
  (request as Request & { cf?: { country?: string } }).cf?.country ?? null;

const reasonOf = (body: ErrorBody): string | null => body.reason ?? (body.scope ? `limit_${body.scope}` : null);

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

interface Ctx {
  env: Env;
  device: DeviceRow;
  raw: Uint8Array;
  now: number;
  deps: PipelineDeps;
}

/** Runs `handler` after the full signed-request checks; logs the attempt under `endpoint`. */
async function signed(
  request: Request,
  env: Env,
  deps: PipelineDeps,
  endpoint: Endpoint,
  maxBody: number,
  handler: (ctx: Ctx) => Promise<unknown>,
): Promise<Response> {
  const started = deps.now();
  const now = Math.floor(started / 1000);
  const country = countryOf(request);
  let keyId: string | null = null;
  let nonce: string | null = null;
  let attemptId: number | null = null;

  const record = async (http: number, outcome: string, reason: string | null): Promise<void> => {
    const ms = deps.now() - started;
    if (attemptId !== null) {
      try {
        await env.DB.prepare("UPDATE attempts SET outcome = ?, reason = ?, http = ?, ms = ? WHERE id = ?")
          .bind(outcome, reason?.slice(0, 64) ?? null, http, ms, attemptId)
          .run();
      } catch {
        // best effort
      }
      return;
    }
    await logAttempt(env, { at: now, keyId, endpoint, outcome, reason, http, nonce: outcome === "replay" ? nonce : null, country, ms });
  };

  try {
    const headers = deps.parseAssertionHeaders(request, now);
    nonce = headers.nonce;
    const device = await env.DB.prepare("SELECT * FROM devices WHERE key_id = ?")
      .bind(headers.keyId)
      .first<DeviceRow>();
    if (!device) throw new HttpError(403, { error: "unknown_device" });
    keyId = device.key_id;

    if (Number(request.headers.get("content-length") ?? "0") > maxBody) {
      throw new HttpError(400, { error: "invalid", reason: "too_large" });
    }
    const raw = await readCapped(request, maxBody);
    const hash = await deps.clientDataHash(request.method, new URL(request.url).pathname, headers.timestamp, headers.nonce, raw);
    const { counter } = await deps.verifyAssertion(env, device, headers, hash);

    const advanced = await env.DB.prepare(
      "UPDATE devices SET counter = ?1, last_seen = ?2 WHERE key_id = ?3 AND counter < ?1",
    )
      .bind(counter, now, device.key_id)
      .run();
    if (advanced.meta.changes === 0) throw new HttpError(409, { error: "replay", reason: "counter" });

    try {
      const reserved = await env.DB.prepare(
        `INSERT INTO attempts (at, key_id, endpoint, outcome, http, nonce, country)
         VALUES (?, ?, ?, 'internal', 500, ?, ?) RETURNING id`,
      )
        .bind(now, device.key_id, endpoint, headers.nonce, country?.slice(0, 8) ?? null)
        .all<{ id: number }>();
      attemptId = reserved.results[0]?.id ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, { error: "replay", reason: "nonce" });
      throw error;
    }

    if (device.status === "pending") throw new HttpError(403, { error: "pending" });
    if (device.status === "denied") throw new HttpError(403, { error: "denied" });

    const body = await handler({ env, device, raw, now, deps });
    await record(200, "ok", null);
    return json(200, body);
  } catch (error) {
    if (error instanceof HttpError) {
      await record(error.http, error.body.error, reasonOf(error.body));
      return errorResponse(error);
    }
    await record(500, "internal", null);
    return json(500, { error: "internal" });
  }
}

// MARK: - Anthropic batches

const upstream = (): HttpError => new HttpError(502, { error: "upstream" });

type Params = Record<string, unknown>;

async function anthropic(ctx: Ctx, method: "GET" | "POST", url: string, body?: unknown): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.deps.fetcher(anthropicRequest(ctx.env, method, url, body));
  } catch {
    throw upstream();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, { error: "upstream", status: response.status });
  }
  return response;
}

/** Creates a batch with the one request; returns Anthropic's batch id. */
async function createBatch(ctx: Ctx, params: Params): Promise<string> {
  const response = await anthropic(ctx, "POST", BATCHES_URL, { requests: [{ custom_id: CUSTOM_ID, params }] });
  const parsed: unknown = await response.json().catch(() => null);
  const id = (parsed as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "" || id.length > 200) throw upstream();
  return id;
}

/** Best-effort cancel: never throws, never changes the answer. */
async function cancelBatch(ctx: Ctx, batchId: string): Promise<void> {
  try {
    const response = await ctx.deps.fetcher(anthropicRequest(ctx.env, "POST", `${BATCHES_URL}/${encodeURIComponent(batchId)}/cancel`, {}));
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // best effort
  }
}

const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface ReviewRow {
  id: string;
  key_id: string;
  batch_id: string;
  params_json: string;
  resumes: number;
  status: "waiting" | "done" | "failed" | "canceled";
  result_text: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const utcDayStart = (seconds: number): number => seconds - (seconds % 86_400);

// MARK: - POST /v1/review

export async function handleReview(request: Request, env: Env, deps: PipelineDeps = defaultDeps): Promise<Response> {
  return signed(request, env, deps, "review", LIMITS.maxReviewBodyBytes, async (ctx) => {
    // Limits first (the reserved attempt row counts, like /v1/request), then the schema.
    const minute = await env.DB.prepare(
      "SELECT COUNT(*) AS c, MIN(at) AS first FROM attempts WHERE key_id = ? AND endpoint = 'review' AND at > ?",
    )
      .bind(ctx.device.key_id, ctx.now - 60)
      .first<{ c: number; first: number | null }>();
    if ((minute?.c ?? 0) > LIMITS.perMinute) {
      throw new HttpError(429, { error: "limit", scope: "minute", retryAfter: Math.max(1, (minute?.first ?? ctx.now) + 60 - ctx.now) });
    }
    const today = await env.DB.prepare("SELECT COUNT(*) AS c FROM review_batches WHERE key_id = ? AND created_at >= ?")
      .bind(ctx.device.key_id, utcDayStart(ctx.now))
      .first<{ c: number }>();
    if ((today?.c ?? 0) >= LIMITS.reviewsPerDay) {
      throw new HttpError(429, { error: "limit", scope: "day", retryAfter: 86_400 - (ctx.now % 86_400) });
    }

    const review = validateReviewBody(ctx.raw);
    const params: Params = {
      model: MODEL,
      max_tokens: LIMITS.maxTokens,
      system: reviewSystemPrompt(review.dutch),
      messages: [{ role: "user", content: reviewUserText(review) }],
      output_config: { effort: "medium" },
      tools: [webSearchTool(25)],
    };

    // Opportunistic cleanup of old finished rows.
    await env.DB.prepare("DELETE FROM review_batches WHERE status <> 'waiting' AND updated_at < ?")
      .bind(ctx.now - LIMITS.reviewRetentionSeconds)
      .run()
      .catch(() => undefined);

    const batchId = await createBatch(ctx, params);
    const id = newId();
    const previous = await env.DB.prepare("SELECT * FROM review_batches WHERE key_id = ? AND status = 'waiting'")
      .bind(ctx.device.key_id)
      .all<ReviewRow>();
    await env.DB.prepare(
      `INSERT INTO review_batches (id, key_id, batch_id, params_json, resumes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'waiting', ?, ?)`,
    )
      .bind(id, ctx.device.key_id, batchId, JSON.stringify(params), ctx.now, ctx.now)
      .run();
    // At most one waiting review per device: the older ones are canceled (at Anthropic best-effort).
    for (const old of previous.results) {
      await env.DB.prepare("UPDATE review_batches SET status = 'canceled', error = 'canceled', updated_at = ? WHERE id = ? AND status = 'waiting'")
        .bind(ctx.now, old.id)
        .run();
      await cancelBatch(ctx, old.batch_id);
    }
    return { id, status: "waiting" };
  });
}

// MARK: - POST /v1/review/status and /v1/review/cancel

async function ownRow(ctx: Ctx, id: string): Promise<ReviewRow> {
  const row = await ctx.env.DB.prepare("SELECT * FROM review_batches WHERE id = ? AND key_id = ?")
    .bind(id, ctx.device.key_id)
    .first<ReviewRow>();
  if (!row) throw new HttpError(404, { error: "not_found" });
  return row;
}

const view = (row: Pick<ReviewRow, "status" | "result_text" | "error">): Record<string, unknown> => {
  if (row.status === "done") return { status: "done", text: row.result_text ?? "" };
  if (row.status === "failed") return { status: "failed", error: row.error ?? "upstream" };
  return { status: row.status };
};

async function finish(ctx: Ctx, row: ReviewRow, status: "done" | "failed", text: string | null, error: string | null): Promise<Record<string, unknown>> {
  await ctx.env.DB.prepare(
    "UPDATE review_batches SET status = ?, result_text = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'waiting'",
  )
    .bind(status, text, error, ctx.now, row.id)
    .run();
  // Someone else may have finished it first (a parallel poll, a cancel): answer what is stored.
  const stored = await ctx.env.DB.prepare("SELECT status, result_text, error FROM review_batches WHERE id = ?")
    .bind(row.id)
    .first<ReviewRow>();
  return view(stored ?? { status, result_text: text, error });
}

interface Block {
  type?: unknown;
  text?: unknown;
}

export async function handleReviewStatus(request: Request, env: Env, deps: PipelineDeps = defaultDeps): Promise<Response> {
  return signed(request, env, deps, "review_status", 1024, async (ctx) => {
    const row = await ownRow(ctx, validateReviewIdBody(ctx.raw));
    if (row.status !== "waiting") return view(row);

    const batchResponse = await anthropic(ctx, "GET", `${BATCHES_URL}/${encodeURIComponent(row.batch_id)}`);
    const batch = (await batchResponse.json().catch(() => null)) as { processing_status?: unknown } | null;
    if (batch === null || typeof batch !== "object") throw upstream();
    if (batch.processing_status !== "ended") return { status: "waiting" };

    const resultsResponse = await anthropic(ctx, "GET", `${BATCHES_URL}/${encodeURIComponent(row.batch_id)}/results`);
    const text = await resultsResponse.text();
    let result: { type?: unknown; message?: { stop_reason?: unknown; content?: unknown } } | undefined;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { custom_id?: unknown; result?: typeof result };
        if (parsed.custom_id === CUSTOM_ID && typeof parsed.result === "object" && parsed.result !== null) result = parsed.result;
      } catch {
        // a garbled line is ignored; no usable line means unreadable
      }
    }
    if (!result) return finish(ctx, row, "failed", null, "unreadable");
    switch (result.type) {
      case "errored":
        return finish(ctx, row, "failed", null, "upstream");
      case "expired":
        return finish(ctx, row, "failed", null, "expired");
      case "canceled":
        return finish(ctx, row, "failed", null, "canceled");
      case "succeeded":
        break;
      default:
        return finish(ctx, row, "failed", null, "unreadable");
    }
    const message = result.message;
    const blocks: Block[] = Array.isArray(message?.content) ? (message.content as Block[]) : [];
    switch (message?.stop_reason) {
      case "refusal":
        return finish(ctx, row, "failed", null, "refused");
      case "max_tokens":
        return finish(ctx, row, "failed", null, "incomplete");
      case "pause_turn": {
        if (row.resumes >= LIMITS.maxResumes) return finish(ctx, row, "failed", null, "incomplete");
        // The paused assistant turn is appended as-is; a NEW batch continues it.
        const params = JSON.parse(row.params_json) as Params;
        (params["messages"] as unknown[]).push({ role: "assistant", content: blocks });
        const batchId = await createBatch(ctx, params);
        const updated = await env.DB.prepare(
          `UPDATE review_batches SET batch_id = ?, params_json = ?, resumes = resumes + 1, updated_at = ?
           WHERE id = ? AND status = 'waiting' AND batch_id = ?`,
        )
          .bind(batchId, JSON.stringify(params), ctx.now, row.id, row.batch_id)
          .run();
        if (updated.meta.changes === 0) await cancelBatch(ctx, batchId); // lost a race with another poll
        return { status: "waiting" };
      }
      default: {
        let answer: string | undefined;
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") answer = block.text.trim();
        }
        if (answer === undefined) return finish(ctx, row, "failed", null, "unreadable");
        return finish(ctx, row, "done", answer, null);
      }
    }
  });
}

export async function handleReviewCancel(request: Request, env: Env, deps: PipelineDeps = defaultDeps): Promise<Response> {
  return signed(request, env, deps, "review_cancel", 1024, async (ctx) => {
    const row = await ownRow(ctx, validateReviewIdBody(ctx.raw));
    if (row.status !== "waiting") return { status: row.status };
    const result = await env.DB.prepare(
      "UPDATE review_batches SET status = 'canceled', error = 'canceled', updated_at = ? WHERE id = ? AND status = 'waiting'",
    )
      .bind(ctx.now, row.id)
      .run();
    if (result.meta.changes > 0) await cancelBatch(ctx, row.batch_id);
    const stored = await env.DB.prepare("SELECT status FROM review_batches WHERE id = ?").bind(row.id).first<{ status: string }>();
    return { status: stored?.status ?? "canceled" };
  });
}
