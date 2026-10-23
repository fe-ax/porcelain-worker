import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { b64encode, sha256 } from "../src/attest";
import { clientDataHash } from "../src/assert";
import { LIMITS } from "../src/types";
import { attemptRows, bytesOf, freshNonce, resetDb, testEnv } from "./helpers";

// End to end through the router with a real software key (ENV=dev in the test bindings).

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://porcelain.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bytesOf(body),
  });

const call = async (request: Request): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await worker.fetch(request, testEnv);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

const challenge = async (ip = "203.0.113.1"): Promise<string> => {
  const r = await call(post("/v1/challenge", {}, { "cf-connecting-ip": ip }));
  expect(r.status).toBe(200);
  return r.json["challenge"] as string;
};

async function makeKey() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return { keys, point, keyId: b64encode(await sha256(point)) };
}
type Key = Awaited<ReturnType<typeof makeKey>>;

const enrollBody = (key: Key, challengeText: string, name = "Alice's iPhone"): Record<string, unknown> => ({
  keyId: key.keyId,
  softwareKey: b64encode(key.point),
  challenge: challengeText,
  device: { name, appVersion: "1.0 (1)", system: "iOS 27.0", env: "simulator" },
});

const enroll = async (key: Key, name?: string) => call(post("/v1/enroll", enrollBody(key, await challenge(), name)));

function derFromRaw(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = [...b.subarray(i)];
    if (v[0]! & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

async function statusRequest(key: Key, counter: number, signWith: Key = key): Promise<Request> {
  const body = bytesOf({});
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = freshNonce().replace(/[^A-Za-z0-9_-]/g, "x").padEnd(16, "x").slice(0, 32);
  const hash = await clientDataHash("POST", "/v1/status", timestamp, nonce, body);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signWith.keys.privateKey, hash));
  return new Request("https://porcelain.example/v1/status", {
    method: "POST",
    headers: {
      "x-porcelain-key": key.keyId,
      "x-porcelain-assertion": b64encode(derFromRaw(raw)),
      "x-porcelain-counter": String(counter),
      "x-porcelain-timestamp": String(timestamp),
      "x-porcelain-nonce": nonce,
    },
    body,
  });
}

const setStatus = (keyId: string, status: string) =>
  testEnv.DB.prepare("UPDATE devices SET status = ? WHERE key_id = ?").bind(status, keyId).run();

beforeEach(resetDb);

describe("/v1/challenge", () => {
  it("returns a 32 byte base64url challenge and logs the attempt", async () => {
    const r = await call(post("/v1/challenge", {}, { "cf-connecting-ip": "203.0.113.9" }));
    expect(r.status).toBe(200);
    expect(r.json["challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(typeof r.json["expiresAt"]).toBe("number");
    expect((await attemptRows()).map((a) => [a.endpoint, a.outcome, a.http])).toEqual([["challenge", "ok", 200]]);
  });

  it("limits per IP per hour, stores only a hash, and other IPs are unaffected", async () => {
    for (let i = 0; i < LIMITS.challengesPerIpPerHour; i++) await challenge("198.51.100.7");
    const over = await call(post("/v1/challenge", {}, { "cf-connecting-ip": "198.51.100.7" }));
    expect(over.status).toBe(429);
    expect(over.json).toMatchObject({ error: "limit", scope: "ip" });
    expect(over.json["retryAfter"]).toBeGreaterThan(0);
    expect((await challenge("198.51.100.8")).length).toBeGreaterThan(0);
    const rows = await testEnv.DB.prepare("SELECT ip_hash FROM challenges").all<{ ip_hash: string }>();
    expect(rows.results.every((r) => r.ip_hash && !r.ip_hash.includes("198.51"))).toBe(true);
    expect((await attemptRows()).some((a) => a.endpoint === "challenge" && a.outcome === "limit")).toBe(true);
  });

  it("rejects a body with fields", async () => {
    const r = await call(post("/v1/challenge", { x: 1 }));
    expect(r).toMatchObject({ status: 400, json: { error: "invalid", reason: "unknown_field" } });
  });
});

describe("/v1/enroll", () => {
  it("enrols a simulator device as pending", async () => {
    const key = await makeKey();
    const r = await enroll(key);
    expect(r).toEqual({ status: 200, json: { status: "pending" } });
    const row = await testEnv.DB.prepare("SELECT status, counter, name, app_version, env FROM devices WHERE key_id = ?")
      .bind(key.keyId).first();
    expect(row).toEqual({ status: "pending", counter: 0, name: "Alice's iPhone", app_version: "1.0 (1)", env: "simulator" });
    expect((await attemptRows()).filter((a) => a.endpoint === "enroll").map((a) => a.outcome)).toEqual(["ok"]);
  });

  it("a challenge is single use", async () => {
    const key = await makeKey();
    const c = await challenge();
    expect((await call(post("/v1/enroll", enrollBody(key, c)))).status).toBe(200);
    const again = await call(post("/v1/enroll", enrollBody(key, c)));
    expect(again).toMatchObject({ status: 400, json: { error: "invalid", reason: "challenge" } });
    const unknown = await call(post("/v1/enroll", enrollBody(key, "A".repeat(43))));
    expect(unknown.json["reason"]).toBe("challenge");
  });

  it("an expired challenge is refused", async () => {
    const key = await makeKey();
    const c = await challenge();
    await testEnv.DB.prepare("UPDATE challenges SET expires_at = ?").bind(Math.floor(Date.now() / 1000) - 1).run();
    expect((await call(post("/v1/enroll", enrollBody(key, c)))).json["reason"]).toBe("challenge");
  });

  it("re-enrolling a denied device keeps it denied and changes nothing", async () => {
    const key = await makeKey();
    await enroll(key, "Original");
    await testEnv.DB.prepare("UPDATE devices SET status = 'denied', counter = 7, decided_by = 'me' WHERE key_id = ?")
      .bind(key.keyId).run();
    const r = await enroll(key, "Renamed");
    expect(r).toEqual({ status: 200, json: { status: "denied" } });
    const row = await testEnv.DB.prepare("SELECT status, counter, name, decided_by FROM devices WHERE key_id = ?")
      .bind(key.keyId).first();
    expect(row).toEqual({ status: "denied", counter: 7, name: "Original", decided_by: "me" });
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS c FROM devices").first<{ c: number }>())?.c).toBe(1);
  });

  it("rejects a software key whose id does not match, and a simulator in production", async () => {
    const key = await makeKey();
    const other = await makeKey();
    const bad = await call(post("/v1/enroll", { ...enrollBody(key, await challenge()), keyId: other.keyId }));
    expect(bad).toMatchObject({ status: 400, json: { error: "invalid", reason: "attestation" } });
    const prod = await worker.fetch(post("/v1/enroll", enrollBody(key, await challenge())), { ...testEnv, ENV: "prod" });
    expect(prod.status).toBe(400);
    expect((await prod.json()) as object).toMatchObject({ reason: "simulator_not_allowed" });
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS c FROM devices").first<{ c: number }>())?.c).toBe(0);
  });
});

describe("/v1/status", () => {
  it("answers pending, approved and denied with a valid assertion and counts nothing against the limits", async () => {
    const key = await makeKey();
    await enroll(key);
    let counter = 1;
    for (const status of ["pending", "approved", "denied"]) {
      await setStatus(key.keyId, status);
      const r = await call(await statusRequest(key, counter++));
      expect(r).toEqual({ status: 200, json: { status } });
    }
    const usage = await testEnv.DB.prepare("SELECT COUNT(*) AS c FROM usage").first<{ c: number }>();
    expect(usage?.c).toBe(0);
    expect((await attemptRows()).filter((a) => a.endpoint === "status").map((a) => a.outcome)).toEqual(["ok", "ok", "ok"]);
  });

  it("requires a valid assertion: wrong key, missing headers, unknown device", async () => {
    const key = await makeKey();
    const stranger = await makeKey();
    await enroll(key);
    const forged = await call(await statusRequest(key, 1, stranger));
    expect(forged).toMatchObject({ status: 400, json: { error: "invalid", reason: "signature" } });
    const bare = await call(post("/v1/status", {}));
    expect(bare).toMatchObject({ status: 400, json: { reason: "headers" } });
    const unknown = await call(await statusRequest(stranger, 1));
    expect(unknown).toMatchObject({ status: 403, json: { error: "unknown_device" } });
    const counter = await testEnv.DB.prepare("SELECT counter FROM devices WHERE key_id = ?").bind(key.keyId).first<{ counter: number }>();
    expect(counter?.counter).toBe(0);
  });

  it("a repeated counter is a replay", async () => {
    const key = await makeKey();
    await enroll(key);
    expect((await call(await statusRequest(key, 1))).status).toBe(200);
    expect(await call(await statusRequest(key, 1))).toMatchObject({ status: 409, json: { error: "replay", reason: "counter" } });
  });
});
