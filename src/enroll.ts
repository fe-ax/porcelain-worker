import { consumeChallenge, createChallenge, d1ChainCache, sha256, b64encode, verifyAttestation, verifySoftwareKey } from "./attest";
import { errorResponse, logAttempt, readCapped, type PipelineDeps, defaultDeps } from "./pipeline";
import { validateEmptyBody, validateEnrollBody } from "./validate";
import { HttpError, LIMITS, type DeviceRow, type Env, type ErrorBody } from "./types";

// /v1/challenge, /v1/enroll, /v1/status (WIRE.md 1.1, 1.2, 1.4). Every outcome is logged as an attempt.

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const countryOf = (request: Request): string | null =>
  (request as Request & { cf?: { country?: string } }).cf?.country ?? null;

const reasonOf = (body: ErrorBody): string | null => body.reason ?? (body.scope ? `limit_${body.scope}` : null);

/** SHA-256 of the IP plus the UTC date as salt, base64. The raw IP is never stored. */
async function hashIp(ip: string, nowSeconds: number): Promise<string> {
  const day = new Date(nowSeconds * 1000).toISOString().slice(0, 10);
  return b64encode(await sha256(new TextEncoder().encode(`porcelain-ip:${day}:${ip}`)));
}

export async function handleChallenge(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  const started = now();
  const seconds = Math.floor(started / 1000);
  const country = countryOf(request);
  const finish = async (http: number, outcome: string, reason: string | null): Promise<void> => {
    await logAttempt(env, { at: seconds, keyId: null, endpoint: "challenge", outcome, reason, http, country, ms: now() - started });
  };
  try {
    validateEmptyBody(await readCapped(request, 1024));
    const ipHash = await hashIp(request.headers.get("cf-connecting-ip") ?? "unknown", seconds);
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS c, MIN(created_at) AS first FROM challenges WHERE ip_hash = ? AND created_at > ?",
    )
      .bind(ipHash, seconds - 3600)
      .first<{ c: number; first: number | null }>();
    if ((recent?.c ?? 0) >= LIMITS.challengesPerIpPerHour) {
      const retryAfter = Math.max(1, (recent?.first ?? seconds) + 3600 - seconds);
      throw new HttpError(429, { error: "limit", scope: "ip", retryAfter });
    }
    const created = await createChallenge(env, seconds, ipHash);
    await finish(200, "ok", null);
    return json(200, created);
  } catch (error) {
    if (error instanceof HttpError) {
      await finish(error.http, error.body.error, reasonOf(error.body));
      return errorResponse(error);
    }
    await finish(500, "internal", null);
    return json(500, { error: "internal" });
  }
}

export async function handleEnroll(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  const started = now();
  const seconds = Math.floor(started / 1000);
  const country = countryOf(request);
  let keyId: string | null = null;
  const finish = async (http: number, outcome: string, reason: string | null): Promise<void> => {
    await logAttempt(env, { at: seconds, keyId, endpoint: "enroll", outcome, reason, http, country, ms: now() - started });
  };
  try {
    const body = validateEnrollBody(await readCapped(request, 100_000));
    keyId = body.keyId;
    const challenge = await consumeChallenge(env, body.challenge, seconds);
    const result =
      body.device.env === "simulator"
        ? await verifySoftwareKey(env, body)
        : await verifyAttestation(env, body, challenge, seconds, undefined, d1ChainCache(env.DB));
    keyId = result.keyId;

    // INSERT OR IGNORE: an existing key id keeps its status, counter and name (a denied device stays denied).
    await env.DB.prepare(
      `INSERT OR IGNORE INTO devices
         (key_id, public_key, counter, status, env, name, app_version, system, country, first_seen, last_seen)
       VALUES (?, ?, 0, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        result.keyId, result.publicKey, body.device.env, body.device.name, body.device.appVersion,
        body.device.system, country?.slice(0, 8) ?? null, seconds, seconds,
      )
      .run();
    const row = await env.DB.prepare("SELECT status FROM devices WHERE key_id = ?")
      .bind(result.keyId)
      .first<{ status: string }>();
    await finish(200, "ok", null);
    return json(200, { status: row?.status ?? "pending" });
  } catch (error) {
    if (error instanceof HttpError) {
      await finish(error.http, error.body.error, reasonOf(error.body));
      return errorResponse(error);
    }
    await finish(500, "internal", null);
    return json(500, { error: "internal" });
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/** Same assertion path as /v1/request (headers, device, signature, counter, nonce), then answers the device status. */
export async function handleStatus(
  request: Request,
  env: Env,
  deps: PipelineDeps = defaultDeps,
): Promise<Response> {
  const started = deps.now();
  const seconds = Math.floor(started / 1000);
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
    await logAttempt(env, {
      at: seconds, keyId, endpoint: "status", outcome, reason, http,
      nonce: outcome === "replay" ? nonce : null, country, ms,
    });
  };

  try {
    const headers = deps.parseAssertionHeaders(request, seconds);
    nonce = headers.nonce;
    const device = await env.DB.prepare("SELECT * FROM devices WHERE key_id = ?")
      .bind(headers.keyId)
      .first<DeviceRow>();
    if (!device) throw new HttpError(403, { error: "unknown_device" });
    keyId = device.key_id;

    const raw = await readCapped(request, 1024);
    const hash = await deps.clientDataHash(request.method, new URL(request.url).pathname, headers.timestamp, headers.nonce, raw);
    const { counter } = await deps.verifyAssertion(env, device, headers, hash);

    const advanced = await env.DB.prepare(
      "UPDATE devices SET counter = ?1, last_seen = ?2 WHERE key_id = ?3 AND counter < ?1",
    )
      .bind(counter, seconds, device.key_id)
      .run();
    if (advanced.meta.changes === 0) throw new HttpError(409, { error: "replay", reason: "counter" });

    try {
      const reserved = await env.DB.prepare(
        `INSERT INTO attempts (at, key_id, endpoint, outcome, http, nonce, country)
         VALUES (?, ?, 'status', 'internal', 500, ?, ?) RETURNING id`,
      )
        .bind(seconds, device.key_id, headers.nonce, country?.slice(0, 8) ?? null)
        .all<{ id: number }>();
      attemptId = reserved.results[0]?.id ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, { error: "replay", reason: "nonce" });
      throw error;
    }

    validateEmptyBody(raw);
    await record(200, "ok", null);
    return json(200, { status: device.status });
  } catch (error) {
    if (error instanceof HttpError) {
      await record(error.http, error.body.error, reasonOf(error.body));
      return errorResponse(error);
    }
    await record(500, "internal", null);
    return json(500, { error: "internal" });
  }
}
