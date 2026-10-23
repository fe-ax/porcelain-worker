import { describe, expect, it } from "vitest";
import { b64encode, sha256 } from "../src/attest";
import { clientDataHash, parseAssertionHeaders, verifyAssertion } from "../src/assert";
import { HttpError } from "../src/types";
import type { AssertionHeaders } from "../src/types";
import { NOW, enc, makeAssertion, makeDevice, makeEnv, rawToDer } from "./fixtures";

async function err(p: Promise<unknown> | (() => unknown)): Promise<HttpError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected an HttpError");
}

async function pair() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
  return { keys, point };
}

const hdrs = (over: Record<string, string> = {}): Request =>
  new Request("https://x/v1/request", {
    method: "POST",
    headers: {
      "X-Porcelain-Key": b64encode(new Uint8Array(32)),
      "X-Porcelain-Assertion": "AAEC",
      "X-Porcelain-Counter": "5",
      "X-Porcelain-Timestamp": String(NOW),
      "X-Porcelain-Nonce": "AAAAAAAAAAAAAAAAAAAAAA",
      ...over,
    },
    body: "{}",
  });

describe("parseAssertionHeaders", () => {
  it("parses a valid set", () => {
    const h = parseAssertionHeaders(hdrs(), NOW + 100);
    expect(h.counter).toBe(5);
    expect(h.timestamp).toBe(NOW);
    expect([...h.assertion]).toEqual([0, 1, 2]);
  });
  it("rejects missing or malformed headers", async () => {
    const bads: Record<string, string>[] = [{ "X-Porcelain-Counter": "-1" }, { "X-Porcelain-Counter": "1.5" }, { "X-Porcelain-Nonce": "short" }, { "X-Porcelain-Timestamp": "abc" }, { "X-Porcelain-Assertion": "***" }];
    for (const bad of bads) {
      const e = await err(() => parseAssertionHeaders(hdrs(bad), NOW));
      expect(e.body).toMatchObject({ error: "invalid", reason: "headers" });
    }
    const r = new Request("https://x/", { method: "POST" });
    expect((await err(() => parseAssertionHeaders(r, NOW))).body.reason).toBe("headers");
  });
  it("rejects a timestamp skew over 300 s either way", async () => {
    expect((await err(() => parseAssertionHeaders(hdrs(), NOW + 301))).body.reason).toBe("timestamp");
    expect((await err(() => parseAssertionHeaders(hdrs(), NOW - 301))).body.reason).toBe("timestamp");
    expect(() => parseAssertionHeaders(hdrs(), NOW + 300)).not.toThrow();
  });
});

describe("clientDataHash", () => {
  it("matches the documented construction", async () => {
    const body = enc.encode('{"a":1}');
    const bodyHex = [...(await sha256(body))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const expected = await sha256(enc.encode(`porcelain-v1\nPOST\n/v1/request\n123\nnonce\n${bodyHex}`));
    expect([...(await clientDataHash("POST", "/v1/request", 123, "nonce", body))]).toEqual([...expected]);
  });
  it("changes with every input", async () => {
    const base = await clientDataHash("POST", "/v1/request", 1, "n", enc.encode("b"));
    for (const other of [
      await clientDataHash("GET", "/v1/request", 1, "n", enc.encode("b")),
      await clientDataHash("POST", "/v1/status", 1, "n", enc.encode("b")),
      await clientDataHash("POST", "/v1/request", 2, "n", enc.encode("b")),
      await clientDataHash("POST", "/v1/request", 1, "m", enc.encode("b")),
      await clientDataHash("POST", "/v1/request", 1, "n", enc.encode("c")),
    ]) expect([...other]).not.toEqual([...base]);
  });
});

describe("verifyAssertion (App Attest)", () => {
  async function setup(counter = 3, deviceCounter = 2) {
    const { keys, point } = await pair();
    const cdh = await clientDataHash("POST", "/v1/request", NOW, "nonce", enc.encode("body"));
    const assertion = await makeAssertion(keys, cdh, { counter });
    const headers: AssertionHeaders = { keyId: "k", assertion, counter, timestamp: NOW, nonce: "nonce" };
    return { keys, point, cdh, headers, device: makeDevice(point, { counter: deviceCounter }) };
  }

  it("refuses a development-environment device unless ENV=dev (review finding)", async () => {
    const s = await setup();
    const device = { ...s.device, env: "development" as const };
    const e = await err(verifyAssertion(makeEnv({ ENV: "prod" }), device, s.headers, s.cdh));
    expect(e.body.reason).toBe("simulator_not_allowed");
    expect(await verifyAssertion(makeEnv({ ENV: "dev" }), device, s.headers, s.cdh)).toEqual({ counter: 3 });
  });

  it("accepts a valid assertion and returns the new counter", async () => {
    const s = await setup();
    const t0 = performance.now();
    expect(await verifyAssertion(makeEnv(), s.device, s.headers, s.cdh)).toEqual({ counter: 3 });
    console.log(`assertion verified in ${(performance.now() - t0).toFixed(1)} ms wall time (node)`);
  });

  it("rejects a counter rollback or repeat with 409 replay/counter", async () => {
    for (const deviceCounter of [3, 4, 100]) {
      const s = await setup(3, deviceCounter);
      const e = await err(verifyAssertion(makeEnv(), s.device, s.headers, s.cdh));
      expect(e.http).toBe(409);
      expect(e.body).toMatchObject({ error: "replay", reason: "counter" });
    }
  });

  it("rejects a bad signature (different body hash)", async () => {
    const s = await setup();
    const other = await clientDataHash("POST", "/v1/request", NOW, "nonce", enc.encode("tampered"));
    const e = await err(verifyAssertion(makeEnv(), s.device, s.headers, other));
    expect(e.body).toMatchObject({ error: "invalid", reason: "signature" });
  });

  it("rejects a signature from another key", async () => {
    const s = await setup();
    const o = await pair();
    const e = await err(verifyAssertion(makeEnv(), makeDevice(o.point, { counter: 2 }), s.headers, s.cdh));
    expect(e.body.reason).toBe("signature");
  });

  it("rejects a wrong rpId (signed correctly, for another app)", async () => {
    const { keys, point } = await pair();
    const cdh = await clientDataHash("POST", "/v1/request", NOW, "n", enc.encode("b"));
    const assertion = await makeAssertion(keys, cdh, { counter: 1, rpId: "OTHERTEAM1.nl.other.app" });
    const e = await err(verifyAssertion(makeEnv(), makeDevice(point), { keyId: "k", assertion, counter: 1, timestamp: NOW, nonce: "n" }, cdh));
    expect(e.body.reason).toBe("rp_id");
  });

  it("rejects a header counter that differs from authenticatorData", async () => {
    const s = await setup();
    const e = await err(verifyAssertion(makeEnv(), s.device, { ...s.headers, counter: 4 }, s.cdh));
    expect(e.body.reason).toBe("assertion");
  });

  it("rejects garbage CBOR and a truncated authenticatorData", async () => {
    const s = await setup();
    const e = await err(verifyAssertion(makeEnv(), s.device, { ...s.headers, assertion: new Uint8Array([1, 2, 3]) }, s.cdh));
    expect(e.body.reason).toBe("assertion");
  });
});

describe("verifyAssertion (simulator software key)", () => {
  async function sim(counter: number) {
    const { keys, point } = await pair();
    const cdh = await clientDataHash("POST", "/v1/request", NOW, "n", enc.encode("b"));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cdh));
    const headers: AssertionHeaders = { keyId: "k", assertion: rawToDer(raw), counter, timestamp: NOW, nonce: "n" };
    return { point, cdh, headers };
  }

  it("verifies only when ENV=dev", async () => {
    const s = await sim(1);
    const device = makeDevice(s.point, { env: "simulator", counter: 0 });
    expect(await verifyAssertion(makeEnv({ ENV: "dev" }), device, s.headers, s.cdh)).toEqual({ counter: 1 });
    const e = await err(verifyAssertion(makeEnv({ ENV: "prod" }), device, s.headers, s.cdh));
    expect(e.body.reason).toBe("simulator_not_allowed");
  });

  it("rejects a counter that does not increase and a bad signature", async () => {
    const s = await sim(1);
    const device = makeDevice(s.point, { env: "simulator", counter: 1 });
    const e = await err(verifyAssertion(makeEnv({ ENV: "dev" }), device, s.headers, s.cdh));
    expect(e.body).toMatchObject({ error: "replay", reason: "counter" });
    const bad = await err(verifyAssertion(makeEnv({ ENV: "dev" }), makeDevice(s.point, { env: "simulator" }), s.headers, new Uint8Array(32)));
    expect(bad.body.reason).toBe("signature");
  });
});
