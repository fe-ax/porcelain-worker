import adminHtml from "./admin.html";
import { LIMITS, type DeviceRow, type DeviceStatus, type Env } from "./types";

// Dashboard (WIRE.md section 8): GET /admin (HTML), GET /admin/api/state, POST /admin/api/(approve|deny|revoke).
// Default: every route needs the admin-token session cookie (POST /admin/login, POST /admin/logout).
// If ADMIN_ACCESS_AUD is set to a real value (not the "placeholder-..." default), a valid Cloudflare Access JWT is
// required instead; verifyAccessJwt stays available for that.

/** Fetch used for the Access team's JWKS; tests inject a stub. */
export type JwksFetcher = (url: string) => Promise<Response>;

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_FORCE_MIN_MS = 60 * 1000;
const jwksCache = new Map<string, { at: number; keys: Jwk[]; fetchedAt: number }>();

/** Drops the cached JWKS (tests). */
export function clearJwksCache(): void {
  jwksCache.clear();
}

async function loadKeys(team: string, fetcher: JwksFetcher, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(team);
  const now = Date.now();
  if (cached && !force && now - cached.at < JWKS_TTL_MS) return cached.keys;
  // A token naming an unknown kid forces a refetch; without a floor, anyone could make the Worker call out on
  // every unauthenticated request. Key rotation is still picked up within a minute.
  if (cached && force && now - cached.fetchedAt < JWKS_FORCE_MIN_MS) return cached.keys;
  const response = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) {
    if (cached) jwksCache.set(team, { ...cached, fetchedAt: now });
    return cached?.keys ?? [];
  }
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(team, { at: now, keys, fetchedAt: now });
  return keys;
}

function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodePart(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(text)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

/**
 * Verifies the Cf-Access-Jwt-Assertion (RS256 signature against the team's JWKS, `aud`, `iss`, `exp`/`nbf`).
 * Returns the email or null. Never throws: anything wrong is null.
 */
export async function verifyAccessJwt(
  env: Env,
  request: Request,
  fetcher: JwksFetcher = (url) => fetch(url),
): Promise<string | null> {
  try {
    const token = request.headers.get("cf-access-jwt-assertion");
    const team = env.ADMIN_ACCESS_TEAM_DOMAIN;
    if (!token || !team || !env.ADMIN_ACCESS_AUD) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodePart(headerPart);
    const payload = decodePart(payloadPart);
    if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload["exp"] !== "number" || payload["exp"] <= now) return null;
    if (typeof payload["nbf"] === "number" && payload["nbf"] > now + 60) return null;
    if (payload["iss"] !== `https://${team}`) return null;
    const aud = payload["aud"];
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(env.ADMIN_ACCESS_AUD)) return null;
    const email = payload["email"];
    if (typeof email !== "string" || email === "") return null;

    let jwk = (await loadKeys(team, fetcher, false)).find((key) => key.kid === header["kid"]);
    if (!jwk) jwk = (await loadKeys(team, fetcher, true)).find((key) => key.kid === header["kid"]);
    if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    return valid ? email : null;
  } catch {
    return null;
  }
}

// MARK: - Responses

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS },
  });

function page(html: string, status = 200): Response {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  return new Response(html.replaceAll("{{nonce}}", nonce), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...SECURITY_HEADERS,
    },
  });
}

// MARK: - Data

const utcDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

async function state(env: Env, who: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const [devices, attempts, usage] = await env.DB.batch([
    env.DB.prepare(
      `SELECT key_id, name, app_version, system, env, country, status, counter, first_seen, last_seen,
              decided_at, decided_by FROM devices ORDER BY first_seen DESC LIMIT 500`,
    ),
    env.DB.prepare(
      `SELECT a.id, a.at, a.key_id, d.name AS device_name, a.endpoint, a.kind, a.outcome, a.reason, a.http,
              a.country, a.ms
       FROM attempts a LEFT JOIN devices d ON d.key_id = a.key_id ORDER BY a.at DESC, a.id DESC LIMIT 100`,
    ),
    env.DB.prepare("SELECT key_id, day, count FROM usage WHERE day >= ? ORDER BY day DESC").bind(
      utcDay(now - 6 * 86_400),
    ),
  ]);
  return json(200, {
    me: who,
    now,
    today: utcDay(now),
    dailyCap: LIMITS.perDay,
    devices: devices?.results ?? [],
    attempts: attempts?.results ?? [],
    usage: usage?.results ?? [],
  });
}

/** Which current statuses an action may start from, and what it sets. */
const ACTIONS: Record<string, { from: DeviceStatus[]; to: DeviceStatus }> = {
  approve: { from: ["pending", "denied"], to: "approved" },
  deny: { from: ["pending"], to: "denied" },
  revoke: { from: ["approved"], to: "denied" },
};

async function decide(request: Request, env: Env, email: string, action: string): Promise<Response> {
  const rule = ACTIONS[action];
  if (!rule) return json(404, { error: "not_found" });
  // A cross-site form cannot set this header, which keeps the cookie-authenticated POST safe from CSRF.
  if (request.headers.get("x-requested-with") !== "porcelain-admin") return json(403, { error: "forbidden" });
  let keyId: unknown;
  try {
    const body: unknown = await request.json();
    keyId = typeof body === "object" && body !== null ? (body as { keyId?: unknown }).keyId : undefined;
  } catch {
    return json(400, { error: "invalid" });
  }
  if (typeof keyId !== "string" || keyId === "" || keyId.length > 64) return json(400, { error: "invalid" });

  const device = await env.DB.prepare("SELECT status FROM devices WHERE key_id = ?")
    .bind(keyId)
    .first<Pick<DeviceRow, "status">>();
  if (!device) return json(404, { error: "unknown_device" });
  const now = Math.floor(Date.now() / 1000);
  // Guarded on the current status so two admins cannot step on each other.
  const placeholders = rule.from.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `UPDATE devices SET status = ?, decided_at = ?, decided_by = ? WHERE key_id = ? AND status IN (${placeholders})`,
  )
    .bind(rule.to, now, email.slice(0, 120), keyId, ...rule.from)
    .run();
  if (result.meta.changes === 0) return json(409, { error: "state", status: device.status });
  return json(200, { keyId, status: rule.to });
}

// MARK: - Token login

const SESSION_COOKIE = "__Host-porcelain-admin";
const SESSION_SECONDS = 12 * 3600;
const MIN_TOKEN_CHARS = 32;
const LOGIN_FAILURES_PER_HOUR = 5;
const CSRF_HEADER = ["x-requested-with", "porcelain-admin"] as const;

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256Bytes = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** Compares two strings by their SHA-256 digests, touching every byte. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let index = 0; index < x.length; index++) diff |= x[index]! ^ y[index]!;
  return diff === 0;
}

const hmacKey = (token: string, usage: ("sign" | "verify")[]): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, usage);

async function sessionCookie(env: Env, now: number): Promise<string> {
  const expiry = now + SESSION_SECONDS;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env.ADMIN_TOKEN, ["sign"]), new TextEncoder().encode(`session:${expiry}`));
  return `${SESSION_COOKIE}=${expiry}.${hex(mac)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}

const clearedCookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

/** True when the request carries a session cookie signed with the current ADMIN_TOKEN and not yet expired. */
async function hasSession(env: Env, request: Request): Promise<boolean> {
  try {
    const header = request.headers.get("cookie") ?? "";
    const raw = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (!raw) return false;
    const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(raw.slice(SESSION_COOKIE.length + 1));
    if (!match) return false;
    const expiry = Number(match[1]);
    if (expiry <= Math.floor(Date.now() / 1000) || expiry > Math.floor(Date.now() / 1000) + SESSION_SECONDS) return false;
    const signature = Uint8Array.from(match[2]!.match(/../g)!.map((pair) => parseInt(pair, 16)));
    return await crypto.subtle.verify("HMAC", await hmacKey(env.ADMIN_TOKEN, ["verify"]), signature, new TextEncoder().encode(`session:${expiry}`));
  } catch {
    return false;
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  if (request.headers.get(CSRF_HEADER[0]) !== CSRF_HEADER[1]) return json(403, { error: "forbidden" });
  const now = Math.floor(Date.now() / 1000);
  const ipHash = hex(await sha256Bytes(`porcelain-admin-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`));
  const failures = await env.DB.prepare("SELECT COUNT(*) AS c FROM admin_login_failures WHERE ip_hash = ? AND at > ?")
    .bind(ipHash, now - 3600)
    .first<{ c: number }>();
  if ((failures?.c ?? 0) >= LOGIN_FAILURES_PER_HOUR) return json(429, { error: "limit" });

  let submitted: unknown;
  try {
    const body: unknown = await request.json();
    submitted = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
  } catch {
    return json(400, { error: "invalid" });
  }
  if (typeof submitted !== "string" || submitted.length > 512 || !(await safeEqual(submitted, env.ADMIN_TOKEN))) {
    await env.DB.prepare("INSERT INTO admin_login_failures (ip_hash, at) VALUES (?, ?)").bind(ipHash, now).run();
    // Never the submitted value.
    console.warn(`admin login failed ip=${ipHash.slice(0, 12)}`);
    return json(401, { error: "unauthorized" });
  }
  const response = json(200, { ok: true });
  response.headers.append("set-cookie", await sessionCookie(env, now));
  return response;
}

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Porcelain admin</title>
<style nonce="{{nonce}}">
  :root { --paper:#F7F3E8; --card:#FFFDF8; --ink:#111111; --muted:#6B665C; --red:#F4B6AE; --green:#BFE3BE; --line:1.5px solid var(--ink); }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.45 ui-monospace, Menlo, Consolas, monospace; }
  main { max-width:420px; margin:0 auto; padding:16px; }
  h1 { margin:24px 0 12px; font:700 22px/1.2 ui-serif, Georgia, serif; }
  form { background:var(--card); border:var(--line); border-radius:3px; box-shadow:2px 2px 0 var(--ink); padding:12px; display:grid; gap:10px; }
  input, button { font:inherit; color:var(--ink); border:var(--line); border-radius:3px; padding:8px 10px; }
  input { background:var(--paper); }
  button { font-weight:700; background:var(--green); box-shadow:2px 2px 0 var(--ink); cursor:pointer; }
  button:disabled { opacity:.5; }
  #error { display:none; border:var(--line); background:var(--red); border-radius:3px; padding:8px 12px; margin-top:12px; }
</style></head>
<body><main>
  <h1>Porcelain admin</h1>
  <form id="form"><label for="token">Admin token</label>
    <input id="token" type="password" autocomplete="current-password" required>
    <button id="go" type="submit">Sign in</button></form>
  <div id="error" role="alert"></div>
</main>
<script nonce="{{nonce}}">
"use strict";
const error = document.getElementById("error");
document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const go = document.getElementById("go");
  go.disabled = true; error.style.display = "none";
  try {
    const res = await fetch("/admin/login", { method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "porcelain-admin" },
      body: JSON.stringify({ token: document.getElementById("token").value }) });
    if (res.ok) { location.reload(); return; }
    error.textContent = res.status === 429 ? "Too many attempts. Try again in an hour." : "Wrong token.";
  } catch (e) { error.textContent = "Could not sign in."; }
  error.style.display = "block"; go.disabled = false;
});
</script></body></html>`;

/** Access mode is on only when ADMIN_ACCESS_AUD holds a real audience tag, not empty or the "placeholder-..." default. */
const accessConfigured = (env: Env): boolean =>
  !!env.ADMIN_ACCESS_AUD && !env.ADMIN_ACCESS_AUD.startsWith("placeholder") && !!env.ADMIN_ACCESS_TEAM_DOMAIN;

/**
 * Dashboard: GET /admin (HTML) and /admin/api/* JSON: devices (pending/approved/denied), last 100 attempts,
 * per-device daily usage; POST approve / deny / revoke. Needs the session cookie from POST /admin/login
 * (401 without; 503 when ADMIN_TOKEN is unset or under 32 characters), or an Access JWT in Access mode.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  jwks: JwksFetcher = (target) => fetch(target),
): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const useAccess = accessConfigured(env);
  if (!useAccess && (typeof env.ADMIN_TOKEN !== "string" || env.ADMIN_TOKEN.length < MIN_TOKEN_CHARS)) {
    return json(503, { error: "admin_not_configured" });
  }

  if (!useAccess && path === "/admin/login") {
    return request.method === "POST" ? login(request, env) : json(405, { error: "method_not_allowed" });
  }
  if (!useAccess && path === "/admin/logout") {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (request.headers.get(CSRF_HEADER[0]) !== CSRF_HEADER[1]) return json(403, { error: "forbidden" });
    const response = json(200, { ok: true });
    response.headers.append("set-cookie", clearedCookie);
    return response;
  }

  let who: string | null;
  if (useAccess) who = await verifyAccessJwt(env, request, jwks);
  else who = (await hasSession(env, request)) ? "admin" : null;
  if (!who) {
    if (!useAccess && path === "/admin" && request.method === "GET") return page(LOGIN_HTML, 401);
    return json(useAccess ? 403 : 401, { error: useAccess ? "forbidden" : "unauthorized" });
  }

  if (path === "/admin") {
    return request.method === "GET" ? page(adminHtml) : json(405, { error: "method_not_allowed" });
  }
  if (path === "/admin/api/state") {
    return request.method === "GET" ? state(env, who) : json(405, { error: "method_not_allowed" });
  }
  const match = /^\/admin\/api\/(approve|deny|revoke)$/.exec(path);
  if (match) {
    return request.method === "POST" ? decide(request, env, who, match[1]!) : json(405, { error: "method_not_allowed" });
  }
  return json(404, { error: "not_found" });
}
