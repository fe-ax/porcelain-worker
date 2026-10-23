import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache, handleAdmin, verifyAccessJwt, type JwksFetcher } from "../src/admin";
import { logAttempt } from "../src/pipeline";
import type { Env } from "../src/types";
import { resetDb, seedDevice, testEnv } from "./helpers";

const AUD = "aud-tag-123";
const TEAM = "example.cloudflareaccess.com";
const TOKEN = "t".repeat(20) + "0123456789abcdef";
const accessEnv: Env = { ...testEnv, DB: testEnv.DB, ADMIN_ACCESS_AUD: AUD, ADMIN_ACCESS_TEAM_DOMAIN: TEAM, ADMIN_TOKEN: "" };
const env: Env = { ...testEnv, DB: testEnv.DB, ADMIN_ACCESS_AUD: accessEnv.ADMIN_ACCESS_AUD, ADMIN_ACCESS_TEAM_DOMAIN: TEAM, ADMIN_TOKEN: TOKEN };

const b64url = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface Pair { privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } }
async function makePair(kid: string): Promise<Pair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as Pair["jwk"] };
}

async function sign(
  pair: Pair,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: pair.jwk.kid, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: "admin@example.com", iat: now, exp: now + 600, ...claims }));
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(signature)}`;
}

let good: Pair;
let other: Pair;
let jwks: ReturnType<typeof vi.fn<JwksFetcher>>;

beforeAll(async () => {
  good = await makePair("kid-good");
  other = await makePair("kid-good"); // same kid, different key: a forged signature
});

beforeEach(async () => {
  await resetDb();
  clearJwksCache();
  jwks = vi.fn<JwksFetcher>(async () => new Response(JSON.stringify({ keys: [good.jwk] })));
});

// Token mode: ADMIN_ACCESS_AUD is the placeholder default, so Access is off.
const tokenEnv: Env = { ...env, ADMIN_ACCESS_AUD: "placeholder-access-aud" };
const CSRF = { "x-requested-with": "porcelain-admin" };

const callWith = (e: Env, path: string, cookie: string | null, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const request = new Request(`https://porcelain.example${path}`, { ...init, headers });
  return handleAdmin(request, e, new URL(request.url), jwks);
};
const call = (path: string, cookie: string | null, init: RequestInit = {}) => callWith(tokenEnv, path, cookie, init);
const post = (action: string, cookie: string | null, keyId: string, extra: Record<string, string> = CSRF) =>
  call(`/admin/api/${action}`, cookie, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ keyId }) });

const COOKIE = "__Host-porcelain-admin";
const loginWith = (e: Env, token: unknown, headers: Record<string, string> = CSRF, ip = "203.0.113.7") =>
  callWith(e, "/admin/login", null, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({ token }),
  });
/** Logs in and returns the "name=value" pair to send back. */
async function session(e: Env = tokenEnv): Promise<string> {
  const response = await loginWith(e, e.ADMIN_TOKEN);
  expect(response.status).toBe(200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("verifyAccessJwt", () => {
  const verify = async (token: string | null) => {
    const request = new Request("https://porcelain.example/admin", token ? { headers: { "cf-access-jwt-assertion": token } } : {});
    return verifyAccessJwt(accessEnv, request, jwks);
  };

  it("accepts a valid token and returns the email", async () => {
    expect(await verify(await sign(good))).toBe("admin@example.com");
  });
  it("accepts aud as a plain string", async () => {
    expect(await verify(await sign(good, { aud: AUD }))).toBe("admin@example.com");
  });
  it("rejects: no header, garbage, wrong audience, wrong issuer, expired, not yet valid, no email", async () => {
    expect(await verify(null)).toBeNull();
    expect(await verify("a.b.c")).toBeNull();
    expect(await verify("not-a-jwt")).toBeNull();
    expect(await verify(await sign(good, { aud: ["someone-else"] }))).toBeNull();
    expect(await verify(await sign(good, { iss: "https://evil.cloudflareaccess.com" }))).toBeNull();
    expect(await verify(await sign(good, { exp: Math.floor(Date.now() / 1000) - 10 }))).toBeNull();
    expect(await verify(await sign(good, { nbf: Math.floor(Date.now() / 1000) + 3600 }))).toBeNull();
    expect(await verify(await sign(good, { email: undefined }))).toBeNull();
  });
  it("rejects a token signed with another key, an unknown kid, and alg none / HS256", async () => {
    expect(await verify(await sign(other))).toBeNull();
    expect(await verify(await sign(good, {}, { kid: "unknown" }))).toBeNull();
    expect(await verify(await sign(good, {}, { alg: "none" }))).toBeNull();
    expect(await verify(await sign(good, {}, { alg: "HS256" }))).toBeNull();
    const [head, body] = (await sign(good)).split(".");
    expect(await verify(`${head}.${body}.`)).toBeNull();
  });
  it("rejects a tampered payload", async () => {
    const [head, , signature] = (await sign(good)).split(".");
    const forged = b64url(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: "attacker@example.com", exp: Math.floor(Date.now() / 1000) + 600 }));
    expect(await verify(`${head}.${forged}.${signature}`)).toBeNull();
  });
  it("is null when the JWKS cannot be fetched or the placeholders are still set", async () => {
    jwks.mockImplementation(async () => new Response("no", { status: 500 }));
    expect(await verify(await sign(good))).toBeNull();
    jwks.mockImplementation(async () => { throw new Error("offline"); });
    expect(await verify(await sign(good))).toBeNull();
    const unset = await verifyAccessJwt({ ...env, ADMIN_ACCESS_AUD: "" }, new Request("https://x/admin", { headers: { "cf-access-jwt-assertion": await sign(good) } }), jwks);
    expect(unset).toBeNull();
  });
  it("caches the JWKS and refetches for an unknown kid at most once a minute", async () => {
    await verify(await sign(good));
    await verify(await sign(good));
    expect(jwks).toHaveBeenCalledTimes(1);
    // Review finding: an attacker-chosen kid must not make the Worker call out on every request.
    for (let index = 0; index < 5; index++) await verify(await sign(good, {}, { kid: `rotated-${index}` }));
    expect(jwks).toHaveBeenCalledTimes(1);
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + 61_000);
    try {
      await verify(await sign(good, {}, { kid: "rotated-later" }));
      expect(jwks).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleAdmin: access", () => {
  it("answers 401 without a session on the API routes and shows the login page on /admin", async () => {
    expect((await call("/admin/api/state", null)).status).toBe(401);
    const login = await call("/admin", null);
    expect(login.status).toBe(401);
    const html = await login.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain("{{nonce}}");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(login.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'/);
    await seedDevice("k1", "pending");
    expect((await post("approve", null, "k1")).status).toBe(401);
    expect((await post("approve", `${COOKIE}=garbage`, "k1")).status).toBe(401);
    const row = await testEnv.DB.prepare("SELECT status FROM devices WHERE key_id = 'k1'").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
  it("serves the page with a nonce CSP and no external assets", async () => {
    const response = await call("/admin", await session());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const csp = response.headers.get("content-security-policy") ?? "";
    const html = await response.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toContain("{{nonce}}");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(html).not.toMatch(/@import|url\(/);
    expect(html).not.toContain("innerHTML");
    expect(csp).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("404s unknown paths and 405s wrong methods", async () => {
    const token = await session();
    expect((await call("/admin/nope", token)).status).toBe(404);
    expect((await call("/admin/api/state", token, { method: "POST" })).status).toBe(405);
    expect((await call("/admin/api/approve", token)).status).toBe(405);
  });
});

describe("handleAdmin: data", () => {
  it("lists devices by status with usage and the last 100 attempts, without public keys", async () => {
    await seedDevice("k-pending", "pending");
    await seedDevice("k-ok", "approved");
    await seedDevice("k-no", "denied");
    const day = new Date().toISOString().slice(0, 10);
    await testEnv.DB.prepare("INSERT INTO usage (key_id, day, count) VALUES ('k-ok', ?, 7)").bind(day).run();
    for (let index = 0; index < 120; index++) {
      await logAttempt(env, { at: 1_800_000_000 + index, keyId: "k-ok", endpoint: "request", kind: "label", outcome: index === 119 ? "pending" : "ok", http: 200, ms: 5 });
    }
    await logAttempt(env, { at: 1_700_000_000, keyId: null, endpoint: "request", outcome: "invalid", reason: "headers", http: 400 });

    const response = await call("/admin/api/state", await session());
    expect(response.status).toBe(200);
    const text = await response.text();
    const state = JSON.parse(text) as {
      me: string; devices: { key_id: string; status: string; name: string }[];
      attempts: { at: number; outcome: string; device_name: string | null; reason: string | null }[];
      usage: { key_id: string; count: number }[]; dailyCap: number;
    };
    expect(state.me).toBe("admin");
    expect(state.dailyCap).toBe(200);
    expect(state.devices.map((device) => [device.key_id, device.status]).sort()).toEqual([["k-no", "denied"], ["k-ok", "approved"], ["k-pending", "pending"]]);
    expect(state.usage).toEqual([{ key_id: "k-ok", day, count: 7 }]);
    expect(state.attempts).toHaveLength(100);
    expect(state.attempts[0]).toMatchObject({ at: 1_800_000_119, outcome: "pending", device_name: "Test iPhone" });
    expect(text).not.toContain("public_key");
  });
});

describe("handleAdmin: decisions", () => {
  const status = async (keyId: string) =>
    (await testEnv.DB.prepare("SELECT status, decided_by, decided_at FROM devices WHERE key_id = ?").bind(keyId).first<{ status: string; decided_by: string | null; decided_at: number | null }>())!;

  it("approve, revoke, approve again; the decider is recorded", async () => {
    await seedDevice("k1", "pending");
    const token = await session();
    expect((await post("approve", token, "k1")).status).toBe(200);
    expect(await status("k1")).toMatchObject({ status: "approved", decided_by: "admin" });
    expect((await status("k1")).decided_at).toBeGreaterThan(0);
    expect((await post("revoke", token, "k1")).status).toBe(200);
    expect((await status("k1")).status).toBe("denied");
    expect((await post("approve", token, "k1")).status).toBe(200);
    expect((await status("k1")).status).toBe("approved");
  });
  it("deny works from pending only; revoke from approved only", async () => {
    await seedDevice("p", "pending");
    await seedDevice("a", "approved");
    const token = await session();
    expect((await post("revoke", token, "p")).status).toBe(409);
    expect((await post("deny", token, "a")).status).toBe(409);
    expect((await post("deny", token, "p")).status).toBe(200);
    expect((await status("p")).status).toBe("denied");
    expect((await status("a")).status).toBe("approved");
  });
  it("404 for an unknown device, 400 for a bad body, 403 without the CSRF header", async () => {
    const token = await session();
    expect((await post("approve", token, "nope")).status).toBe(404);
    expect((await post("approve", token, "x".repeat(65))).status).toBe(400);
    const bad = await call("/admin/api/approve", token, { method: "POST", headers: { "x-requested-with": "porcelain-admin" }, body: "{" });
    expect(bad.status).toBe(400);
    await seedDevice("k1", "pending");
    expect((await post("approve", token, "k1", {})).status).toBe(403);
    expect((await status("k1")).status).toBe("pending");
  });
  it("a SQL-looking key id is just an unknown device", async () => {
    await seedDevice("k1", "pending");
    expect((await post("approve", await session(), "k1' OR '1'='1")).status).toBe(404);
    expect((await status("k1")).status).toBe("pending");
  });
});

describe("handleAdmin: token login", () => {
  const failures = async () =>
    (await testEnv.DB.prepare("SELECT COUNT(*) AS c FROM admin_login_failures").first<{ c: number }>())!.c;

  it("503 on every admin route when ADMIN_TOKEN is unset or shorter than 32 characters", async () => {
    for (const token of ["", "short-token", "x".repeat(31), undefined as unknown as string]) {
      const weak: Env = { ...tokenEnv, ADMIN_TOKEN: token };
      for (const path of ["/admin", "/admin/api/state", "/admin/login"]) {
        expect((await callWith(weak, path, null)).status).toBe(503);
      }
      expect((await loginWith(weak, token ?? "")).status).toBe(503);
    }
  });
  it("wrong token: 401, no cookie, failure recorded without the submitted value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await loginWith(tokenEnv, "wrong-secret-value");
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await failures()).toBe(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("wrong-secret-value");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect((await loginWith(tokenEnv, 12345)).status).toBe(401);
    expect((await loginWith(tokenEnv, undefined)).status).toBe(401);
  });
  it("right token: sets the hardened cookie and the dashboard opens with it", async () => {
    const response = await loginWith(tokenEnv, TOKEN);
    expect(response.status).toBe(200);
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(new RegExp(`^${COOKIE}=\\d+\\.[0-9a-f]{64};`));
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) expect(header).toContain(part);
    expect(header).not.toContain("Domain");
    const cookie = header.split(";")[0]!;
    const page = await call("/admin", cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Porcelain devices");
    expect((await call("/admin/api/state", cookie)).status).toBe(200);
    expect(await failures()).toBe(0);
  });
  it("rejects a tampered or expired cookie", async () => {
    const cookie = await session();
    const [expiry, mac] = cookie.slice(COOKIE.length + 1).split(".") as [string, string];
    // Later expiry with the old MAC, flipped MAC, malformed, wrong name.
    expect((await call("/admin/api/state", `${COOKIE}=${Number(expiry) + 60}.${mac}`)).status).toBe(401);
    expect((await call("/admin/api/state", `${COOKIE}=${expiry}.${(mac[0] === "a" ? "b" : "a") + mac.slice(1)}`)).status).toBe(401);
    expect((await call("/admin/api/state", `${COOKIE}=${expiry}`)).status).toBe(401);
    expect((await call("/admin/api/state", `porcelain-admin=${expiry}.${mac}`)).status).toBe(401);
    // Properly signed, but already expired: 13 hours later.
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + 13 * 3600_000);
    try {
      expect((await call("/admin/api/state", cookie)).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    expect((await call("/admin/api/state", cookie)).status).toBe(200);
  });
  it("rotating ADMIN_TOKEN invalidates every session", async () => {
    const cookie = await session();
    const rotated: Env = { ...tokenEnv, ADMIN_TOKEN: "r".repeat(40) };
    expect((await callWith(rotated, "/admin/api/state", cookie)).status).toBe(401);
    expect((await callWith(rotated, "/admin", cookie)).status).toBe(401);
  });
  it("limits failed logins to 5 per hour per IP, then 429 even for the right token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let index = 0; index < 5; index++) expect((await loginWith(tokenEnv, "nope", CSRF, "198.51.100.1")).status).toBe(401);
      expect((await loginWith(tokenEnv, "nope", CSRF, "198.51.100.1")).status).toBe(429);
      expect((await loginWith(tokenEnv, TOKEN, CSRF, "198.51.100.1")).status).toBe(429);
      expect(await failures()).toBe(5);
      // Another IP is unaffected.
      expect((await loginWith(tokenEnv, TOKEN, CSRF, "198.51.100.2")).status).toBe(200);
      // After an hour the window has passed.
      const real = Date.now();
      const spy = vi.spyOn(Date, "now").mockReturnValue(real + 3601_000);
      try {
        expect((await loginWith(tokenEnv, TOKEN, CSRF, "198.51.100.1")).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    } finally {
      warn.mockRestore();
    }
  });
  it("login and logout need the CSRF header; logout clears the cookie", async () => {
    expect((await loginWith(tokenEnv, TOKEN, {})).status).toBe(403);
    expect(await failures()).toBe(0);
    expect((await call("/admin/logout", null, { method: "POST" })).status).toBe(403);
    const out = await call("/admin/logout", null, { method: "POST", headers: CSRF });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/admin/logout", null)).status).toBe(405);
    expect((await call("/admin/login", null)).status).toBe(405);
  });
  it("state-changing API POSTs still need the CSRF header with a valid session", async () => {
    await seedDevice("k1", "pending");
    const cookie = await session();
    expect((await post("approve", cookie, "k1", {})).status).toBe(403);
    expect((await post("approve", cookie, "k1")).status).toBe(200);
  });
  it("Access mode (real ADMIN_ACCESS_AUD) uses the JWT and ignores the token flow", async () => {
    const token = await sign(good);
    const viaJwt = (path: string, value: string | null) =>
      callWith(accessEnv, path, null, value ? { headers: { "cf-access-jwt-assertion": value } } : {});
    expect((await viaJwt("/admin/api/state", null)).status).toBe(403);
    const ok = await viaJwt("/admin/api/state", token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { me: string }).me).toBe("admin@example.com");
    expect((await callWith(accessEnv, "/admin/login", null, { method: "POST", headers: CSRF })).status).toBe(403);
  });
});
