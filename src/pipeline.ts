import { clientDataHash, parseAssertionHeaders, verifyAssertion } from "./assert";
import { callClaude, parseAnswer, type Fetcher } from "./claude";
import { buildClaudeCall } from "./prompts";
import { validateRequestBody } from "./validate";
import {
  HttpError,
  LIMITS,
  type AssertionHeaders,
  type DeviceRow,
  type Env,
  type ErrorBody,
  type RequestKind,
  type RequestResponse,
} from "./types";

// The /v1/request pipeline (WIRE.md sections 1.3, 2, 3, 4):
//   headers -> device known -> body read (size cap) -> assertion -> counter + nonce reserved
//   -> device approved -> per-minute / per-day limit -> body schema -> daily usage claimed -> Claude -> output schema.
// Claude is contacted only at the very end; every earlier failure is an HttpError that is logged as an attempt.

/** What the pipeline needs from the outside; tests replace them. Defaults are the real implementations. */
export interface PipelineDeps {
  parseAssertionHeaders: (request: Request, nowSeconds: number) => AssertionHeaders;
  clientDataHash: typeof clientDataHash;
  verifyAssertion: typeof verifyAssertion;
  /** Fetch used for api.anthropic.com. */
  fetcher: Fetcher;
  now: () => number;
}

export const defaultDeps: PipelineDeps = {
  parseAssertionHeaders,
  clientDataHash,
  verifyAssertion,
  fetcher: (input) => fetch(input),
  now: () => Date.now(),
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export function errorResponse(error: HttpError): Response {
  const extra: Record<string, string> = {};
  if (error.body.retryAfter !== undefined) extra["retry-after"] = String(error.body.retryAfter);
  return json(error.http, error.body, extra);
}

/** The attempt row's text columns are length-capped on write. */
const cap = (text: string | null | undefined, max = 64): string | null =>
  text === null || text === undefined ? null : text.slice(0, max);

export interface AttemptLog {
  at: number;
  keyId: string | null;
  endpoint: "challenge" | "enroll" | "request" | "status" | "review" | "review_status" | "review_cancel";
  kind?: RequestKind | null;
  outcome: string;
  reason?: string | null;
  http: number;
  nonce?: string | null;
  country?: string | null;
  ms?: number | null;
}

/** Inserts one attempts row (best effort: a logging failure never changes the answer). Returns its id. */
export async function logAttempt(env: Env, row: AttemptLog): Promise<number | null> {
  try {
    const result = await env.DB.prepare(
      `INSERT INTO attempts (at, key_id, endpoint, kind, outcome, reason, http, nonce, country, ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        row.at, cap(row.keyId), row.endpoint, row.kind ?? null, row.outcome, cap(row.reason), row.http,
        cap(row.nonce), cap(row.country, 8), row.ms ?? null,
      )
      .all<{ id: number }>();
    return result.results[0]?.id ?? null;
  } catch {
    return null;
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function secondsToUtcMidnight(seconds: number): number {
  return 86_400 - (seconds % 86_400);
}

/**
 * Reads the body but never more than `max` bytes: Content-Length is only a hint (chunked uploads have none), so the
 * stream itself is counted and cancelled the moment it passes the cap. Throws HttpError(400, invalid/too_large).
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  const stream = request.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(400, { error: "invalid", reason: "too_large" });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function handleRequest(
  request: Request,
  env: Env,
  deps: PipelineDeps = defaultDeps,
): Promise<Response> {
  const startedMs = deps.now();
  const now = Math.floor(startedMs / 1000);
  const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;

  let keyId: string | null = null;
  let nonce: string | null = null;
  let kind: RequestKind | null = null;
  let attemptId: number | null = null;

  /** Records how the attempt ended: updates the reserved row, or inserts one. */
  const record = async (http: number, outcome: string, reason: string | null): Promise<void> => {
    const ms = deps.now() - startedMs;
    if (attemptId !== null) {
      try {
        await env.DB.prepare("UPDATE attempts SET outcome = ?, reason = ?, http = ?, kind = ?, ms = ? WHERE id = ?")
          .bind(outcome, cap(reason), http, kind, ms, attemptId)
          .run();
      } catch {
        // see logAttempt
      }
      return;
    }
    // A rejected nonce keeps it (the unique index skips 'replay' rows); other early failures never store an
    // unverified nonce, so nobody can burn a legitimate one.
    await logAttempt(env, {
      at: now, keyId, endpoint: "request", kind, outcome, reason, http,
      nonce: outcome === "replay" ? nonce : null, country, ms,
    });
  };

  try {
    const headers = deps.parseAssertionHeaders(request, now);
    nonce = headers.nonce;

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > LIMITS.maxBodyBytes) throw new HttpError(400, { error: "invalid", reason: "too_large" });

    const device = await env.DB.prepare("SELECT * FROM devices WHERE key_id = ?")
      .bind(headers.keyId)
      .first<DeviceRow>();
    if (!device) throw new HttpError(403, { error: "unknown_device" });
    keyId = device.key_id;

    const body = await readCapped(request, LIMITS.maxBodyBytes);

    // Authenticity first: nothing below runs for a request the device did not sign.
    const url = new URL(request.url);
    const hash = await deps.clientDataHash(request.method, url.pathname, headers.timestamp, headers.nonce, body);
    const { counter } = await deps.verifyAssertion(env, device, headers, hash);

    const advanced = await env.DB.prepare(
      "UPDATE devices SET counter = ?1, last_seen = ?2 WHERE key_id = ?3 AND counter < ?1",
    )
      .bind(counter, now, device.key_id)
      .run();
    if (advanced.meta.changes === 0) throw new HttpError(409, { error: "replay", reason: "counter" });

    // Reserve the nonce: the unique (key_id, nonce) index makes a repeat fail here.
    try {
      const reserved = await env.DB.prepare(
        `INSERT INTO attempts (at, key_id, endpoint, outcome, http, nonce, country)
         VALUES (?, ?, 'request', 'internal', 500, ?, ?) RETURNING id`,
      )
        .bind(now, device.key_id, headers.nonce, cap(country, 8))
        .all<{ id: number }>();
      attemptId = reserved.results[0]?.id ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, { error: "replay", reason: "nonce" });
      throw error;
    }

    if (device.status === "pending") throw new HttpError(403, { error: "pending" });
    if (device.status === "denied") throw new HttpError(403, { error: "denied" });

    await checkLimits(env, device.key_id, now);

    const validated = validateRequestBody(body);
    kind = validated.kind;

    const call = buildClaudeCall(validated);
    await claimDailyUse(env, device.key_id, now);

    const answer = parseAnswer(validated.kind, await callClaude(env, call, deps.fetcher));
    await record(200, "ok", null);
    return json(200, { kind: validated.kind, answer } as RequestResponse);
  } catch (error) {
    if (error instanceof HttpError) {
      await record(error.http, error.body.error, reasonOf(error.body));
      return errorResponse(error);
    }
    await record(500, "internal", null);
    return json(500, { error: "internal" });
  }
}

const reasonOf = (body: ErrorBody): string | null => body.reason ?? (body.scope ? `limit_${body.scope}` : null);

/**
 * Per-device limits (WIRE.md 4.1): requests in the last 60 s (rejected ones count, so hammering does not help;
 * the reserved row of this request is included) and the UTC-day total of requests that reached Claude.
 */
async function checkLimits(env: Env, keyId: string, now: number): Promise<void> {
  const minute = await env.DB.prepare(
    "SELECT COUNT(*) AS c, MIN(at) AS first FROM attempts WHERE key_id = ? AND endpoint = 'request' AND at > ?",
  )
    .bind(keyId, now - 60)
    .first<{ c: number; first: number | null }>();
  if ((minute?.c ?? 0) > LIMITS.perMinute) {
    const retryAfter = Math.max(1, (minute?.first ?? now) + 60 - now);
    throw new HttpError(429, { error: "limit", scope: "minute", retryAfter });
  }
  const day = await env.DB.prepare("SELECT count FROM usage WHERE key_id = ? AND day = ?")
    .bind(keyId, utcDay(now))
    .first<{ count: number }>();
  if ((day?.count ?? 0) >= LIMITS.perDay) {
    throw new HttpError(429, { error: "limit", scope: "day", retryAfter: secondsToUtcMidnight(now) });
  }
}

/** Atomically counts one Claude call against the day; returns nothing back when the day's cap is reached. */
async function claimDailyUse(env: Env, keyId: string, now: number): Promise<void> {
  const claimed = await env.DB.prepare(
    `INSERT INTO usage (key_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key_id, day) DO UPDATE SET count = count + 1 WHERE count < ?3
     RETURNING count`,
  )
    .bind(keyId, utcDay(now), LIMITS.perDay)
    .all<{ count: number }>();
  if (claimed.results.length === 0) {
    throw new HttpError(429, { error: "limit", scope: "day", retryAfter: secondsToUtcMidnight(now) });
  }
}
