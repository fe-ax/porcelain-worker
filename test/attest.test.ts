import { describe, expect, it, vi } from "vitest";
import {
  APPLE_APP_ATTEST_ROOT_PEM,
  b64encode,
  consumeChallenge,
  createChallenge,
  d1ChainCache,
  type ChainCache,
  parseCert,
  pemToDer,
  sha256,
  verifyAttestation,
  verifyCertSignature,
  verifySoftwareKey,
} from "../src/attest";
import { HttpError } from "../src/types";
import type { EnrollBody } from "../src/types";
import { NOW, fakeD1, makeAttestation, makeCa, makeEnv, pem, testRoot } from "./fixtures";
import { testEnv } from "./helpers";

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) {
      expect(e.http).toBe(400);
      expect(e.body.error).toBe("invalid");
      return e.body.reason ?? "";
    }
    throw e;
  }
  return "no error";
}

describe("verifyAttestation", () => {
  it("accepts a valid attestation", async () => {
    const a = await makeAttestation();
    const t0 = performance.now();
    const r = await verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem);
    const ms = performance.now() - t0;
    console.log(`valid attestation verified in ${ms.toFixed(1)} ms wall time (node, includes JIT warm-up)`);
    expect(r.counter).toBe(0);
    expect(r.keyId).toBe(a.body.keyId);
    expect([...r.publicKey]).toEqual([...a.point]);
  });

  it("accepts a development attestation only when ENV=dev", async () => {
    const a = await makeAttestation({ aaguid: "dev", env: "development" });
    await expect(verifyAttestation(makeEnv({ ENV: "dev" }), a.body, a.challengeBytes, NOW, a.rootPem)).resolves.toBeTruthy();
    expect(await reason(verifyAttestation(makeEnv({ ENV: "prod" }), a.body, a.challengeBytes, NOW, a.rootPem))).toBe("attestation");
  });

  it("rejects the wrong aaguid for the claimed env", async () => {
    const a = await makeAttestation({ aaguid: "dev", env: "production" });
    expect(await reason(verifyAttestation(makeEnv({ ENV: "dev" }), a.body, a.challengeBytes, NOW, a.rootPem))).toBe("attestation");
    const b = await makeAttestation({ aaguid: "prod", env: "development" });
    expect(await reason(verifyAttestation(makeEnv({ ENV: "dev" }), b.body, b.challengeBytes, NOW, b.rootPem))).toBe("attestation");
  });

  it("rejects a wrong rpId", async () => {
    const a = await makeAttestation({ rpId: "OTHERTEAM1.nl.feax.porcelain" });
    expect(await reason(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem))).toBe("rp_id");
  });

  it("rejects a wrong nonce (cert nonce computed from another challenge)", async () => {
    const a = await makeAttestation({ nonceChallenge: crypto.getRandomValues(new Uint8Array(32)) });
    expect(await reason(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem))).toBe("nonce");
  });

  it("rejects a replayed challenge (attestation made for challenge A, presented with challenge B)", async () => {
    const a = await makeAttestation();
    const other = crypto.getRandomValues(new Uint8Array(32));
    expect(await reason(verifyAttestation(makeEnv(), a.body, other, NOW, a.rootPem))).toBe("nonce");
  });

  it("rejects a chain that does not lead to the pinned root", async () => {
    const a = await makeAttestation({ rogueIntermediate: true });
    expect(await reason(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem))).toBe("chain");
  });

  it("rejects the real Apple root when the chain is synthetic", async () => {
    const a = await makeAttestation();
    expect(await reason(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW))).toBe("chain");
  });

  it("rejects an expired intermediate", async () => {
    const a = await makeAttestation({ intermediateValidity: { notBefore: NOW - 1000, notAfter: NOW - 10 } });
    expect(await reason(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem))).toBe("chain");
  });

  it("rejects a non-zero counter, a wrong credentialId, a wrong keyId and a wrong fmt", async () => {
    const c = await makeAttestation({ counter: 1 });
    expect(await reason(verifyAttestation(makeEnv(), c.body, c.challengeBytes, NOW, c.rootPem))).toBe("attestation");
    const d = await makeAttestation({ credIdOverride: new Uint8Array(32) });
    expect(await reason(verifyAttestation(makeEnv(), d.body, d.challengeBytes, NOW, d.rootPem))).toBe("attestation");
    const e = await makeAttestation();
    const bad: EnrollBody = { ...e.body, keyId: b64encode(new Uint8Array(32)) };
    expect(await reason(verifyAttestation(makeEnv(), bad, e.challengeBytes, NOW, e.rootPem))).toBe("attestation");
    const f = await makeAttestation({ fmt: "packed" });
    expect(await reason(verifyAttestation(makeEnv(), f.body, f.challengeBytes, NOW, f.rootPem))).toBe("attestation");
  });

  it("rejects garbage and a missing attestation", async () => {
    const a = await makeAttestation();
    expect(await reason(verifyAttestation(makeEnv(), { ...a.body, attestation: "AAAA" }, a.challengeBytes, NOW, a.rootPem))).toBe("attestation");
    const { attestation: _drop, ...rest } = a.body;
    expect(await reason(verifyAttestation(makeEnv(), rest as EnrollBody, a.challengeBytes, NOW, a.rootPem))).toBe("attestation");
  });

  it("rejects a tampered attestation (bit flip in the leaf certificate)", async () => {
    const a = await makeAttestation();
    const raw = Uint8Array.from(atob(a.body.attestation ?? ""), (c) => c.charCodeAt(0));
    // flip a byte inside the leaf's tbs (well after the CBOR header)
    raw[140] = (raw[140] ?? 0) ^ 0xff;
    const body = { ...a.body, attestation: b64encode(raw) };
    const r = await reason(verifyAttestation(makeEnv(), body, a.challengeBytes, NOW, a.rootPem));
    expect(["chain", "attestation", "nonce"]).toContain(r);
  });
});

describe("pinned Apple root", () => {
  it("parses, is named Apple App Attestation Root CA and expires 2045-03-15", () => {
    const c = parseCert(pemToDer(APPLE_APP_ATTEST_ROOT_PEM));
    expect(new TextDecoder().decode(c.subject)).toContain("Apple App Attestation Root CA");
    expect(c.notAfter).toBe(Date.UTC(2045, 2, 15) / 1000);
  });

  // KNOWN FAILING: the pinned PEM is an unverified placeholder (see attest.ts). When Apple's official PEM is pasted in,
  // this starts passing, `it.fails` then fails the suite: remove `.fails`.
  it("is self-signed (its signature verifies against its own key)", async () => {
    const c = parseCert(pemToDer(APPLE_APP_ATTEST_ROOT_PEM));
    expect(await verifyCertSignature(c, c.spki)).toBe(true);
  });
});

describe("verifySoftwareKey", () => {
  async function sw() {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const point = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
    const body: EnrollBody = {
      keyId: b64encode(await sha256(point)),
      softwareKey: b64encode(point),
      challenge: "x",
      device: { name: "Sim", appVersion: "1", system: "iOS 27", env: "simulator" },
    };
    return { body, point };
  }

  it("accepts a simulator key only when ENV=dev", async () => {
    const { body, point } = await sw();
    const r = await verifySoftwareKey(makeEnv({ ENV: "dev" }), body);
    expect([...r.publicKey]).toEqual([...point]);
    expect(await reason(verifySoftwareKey(makeEnv({ ENV: "prod" }), body))).toBe("simulator_not_allowed");
  });

  it("rejects a keyId that is not the hash of the point, and a point off the curve", async () => {
    const { body } = await sw();
    expect(await reason(verifySoftwareKey(makeEnv({ ENV: "dev" }), { ...body, keyId: b64encode(new Uint8Array(32)) }))).toBe("attestation");
    const off = new Uint8Array(65);
    off[0] = 4;
    off[64] = 1;
    expect(await reason(verifySoftwareKey(makeEnv({ ENV: "dev" }), { ...body, softwareKey: b64encode(off), keyId: b64encode(await sha256(off)) }))).toBe("attestation");
  });

  it("rejects an attestation sent together with a software key", async () => {
    const { body } = await sw();
    expect(await reason(verifySoftwareKey(makeEnv({ ENV: "dev" }), { ...body, attestation: "AAAA" }))).toBe("attestation");
  });
});

describe("challenge storage", () => {
  it("is single use and expires", async () => {
    const { db } = fakeD1();
    const env = makeEnv({}, db);
    const { challenge, expiresAt } = await createChallenge(env, NOW, null);
    expect(expiresAt).toBe(NOW + 300);
    const bytes = await consumeChallenge(env, challenge, NOW + 10);
    expect(bytes.length).toBe(32);
    expect(await reason(consumeChallenge(env, challenge, NOW + 11))).toBe("challenge"); // replayed
    const second = await createChallenge(env, NOW, null);
    expect(await reason(consumeChallenge(env, second.challenge, NOW + 301))).toBe("challenge"); // expired
    expect(await reason(consumeChallenge(env, "not-a-challenge", NOW))).toBe("challenge");
  });
});


describe("verified-intermediate cache (skips one P-384 verify, nothing else)", () => {
  const memoryCache = (): ChainCache & { rows: Set<string>; hits: number } => {
    const rows = new Set<string>();
    const c = {
      rows,
      hits: 0,
      async has(cert: Uint8Array, root: Uint8Array) {
        const h = rows.has(b64encode(cert) + "|" + b64encode(root));
        if (h) c.hits++;
        return h;
      },
      async remember(cert: Uint8Array, root: Uint8Array) {
        rows.add(b64encode(cert) + "|" + b64encode(root));
      },
    };
    return c;
  };

  /** Counts crypto.subtle.verify calls made while `f` runs. */
  async function verifies(f: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(crypto.subtle, "verify");
    try {
      await f();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it("first enrolment verifies leaf and intermediate and remembers the intermediate; the next one verifies only the leaf", async () => {
    const root = await testRoot();
    const inter = await makeCa("Test App Attestation CA 1", root);
    const cache = memoryCache();
    const a = await makeAttestation({ intermediate: inter });
    expect(await verifies(() => verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, cache))).toBe(2);
    expect(cache.rows.size).toBe(1);
    const b = await makeAttestation({ intermediate: inter });
    let result: unknown;
    const n = await verifies(async () => {
      result = await verifyAttestation(makeEnv(), b.body, b.challengeBytes, NOW, b.rootPem, cache);
    });
    expect(n).toBe(1);
    expect(cache.hits).toBe(1);
    expect((result as { keyId: string }).keyId).toBe(b.body.keyId);
  });

  it("a cached intermediate does not vouch for a forged one with the same name (different bytes)", async () => {
    const root = await testRoot();
    const cache = memoryCache();
    const good = await makeAttestation({ intermediate: await makeCa("Test App Attestation CA 1", root) });
    await verifyAttestation(makeEnv(), good.body, good.challengeBytes, NOW, good.rootPem, cache);
    // same subject and issuer names, but signed by a rogue key instead of the root
    const rogue = await makeCa("Rogue Root");
    const forged = await makeCa("Test App Attestation CA 1", { ...rogue, cn: root.cn });
    const a = await makeAttestation({ intermediate: forged });
    expect(await reason(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, cache))).toBe("chain");
    expect(cache.rows.size).toBe(1);
  });

  it("a cached intermediate is not trusted once it is expired or not yet valid", async () => {
    const root = await testRoot();
    const inter = await makeCa("Test App Attestation CA 1", root, { notBefore: NOW - 1000, notAfter: NOW + 1000 });
    const cache = memoryCache();
    const a = await makeAttestation({ intermediate: inter });
    await verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, cache);
    const b = await makeAttestation({ intermediate: inter });
    expect(await reason(verifyAttestation(makeEnv(), b.body, b.challengeBytes, NOW + 2000, b.rootPem, cache))).toBe("chain");
    expect(await reason(verifyAttestation(makeEnv(), b.body, b.challengeBytes, NOW - 2000, b.rootPem, cache))).toBe("chain");
    expect(cache.hits).toBe(0);
  });

  it("with a cached intermediate a tampered or foreign-signed leaf is still rejected", async () => {
    const root = await testRoot();
    const inter = await makeCa("Test App Attestation CA 1", root);
    const cache = memoryCache();
    const a = await makeAttestation({ intermediate: inter });
    await verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, cache);

    // bit flip inside the leaf's TBS
    const b = await makeAttestation({ intermediate: inter });
    const raw = Uint8Array.from(atob(b.body.attestation ?? ""), (c) => c.charCodeAt(0));
    raw[140] = (raw[140] ?? 0) ^ 0xff;
    const flipped = { ...b.body, attestation: b64encode(raw) };
    expect(["chain", "attestation", "nonce"]).toContain(await reason(verifyAttestation(makeEnv(), flipped, b.challengeBytes, NOW, b.rootPem, cache)));

    // leaf signed by a different key than the cached intermediate's, while x5c carries the cached intermediate
    const other = await makeCa("Test App Attestation CA 1", root);
    const c = await makeAttestation({ intermediate: other, presentedIntermediate: inter });
    expect(await reason(verifyAttestation(makeEnv(), c.body, c.challengeBytes, NOW, c.rootPem, cache))).toBe("chain");
  });

  it("a row cached under another root does not count", async () => {
    const root = await testRoot();
    const inter = await makeCa("Test App Attestation CA 1", root);
    const cache = memoryCache();
    const a = await makeAttestation({ intermediate: inter });
    await verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, cache);
    // a different root with the same subject name: the intermediate bytes are the same but were never verified against it
    const impostor = await makeCa(root.cn);
    const b = await makeAttestation({ intermediate: inter });
    expect(await reason(verifyAttestation(makeEnv(), b.body, b.challengeBytes, NOW, pem(impostor.der), cache))).toBe("chain");
    expect(cache.hits).toBe(0);
  });

  it("a failing cache falls back to full verification", async () => {
    const broken: ChainCache = {
      has: async () => {
        throw new Error("d1 down");
      },
      remember: async () => {
        throw new Error("d1 down");
      },
    };
    const a = await makeAttestation();
    await expect(verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, broken)).resolves.toBeTruthy();
    const rogue = await makeAttestation({ rogueIntermediate: true });
    expect(await reason(verifyAttestation(makeEnv(), rogue.body, rogue.challengeBytes, NOW, rogue.rootPem, broken))).toBe("chain");
  });

  it("the D1 cache stores one row per (intermediate, root), ignores repeats, and works end to end", async () => {
    const root = await testRoot();
    const inter = await makeCa("Test App Attestation CA 1", root);
    const cache = d1ChainCache(testEnv.DB);
    await testEnv.DB.prepare("DELETE FROM verified_intermediates").run();
    const a = await makeAttestation({ intermediate: inter });
    await verifyAttestation(makeEnv(), a.body, a.challengeBytes, NOW, a.rootPem, cache);
    const b = await makeAttestation({ intermediate: inter });
    expect(await verifies(() => verifyAttestation(makeEnv(), b.body, b.challengeBytes, NOW, b.rootPem, cache))).toBe(1);
    const rows = await testEnv.DB.prepare("SELECT cert_sha256, root_sha256, not_after FROM verified_intermediates").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.not_after).toBe(parseCert(inter.der).notAfter);
    await cache.remember(await sha256(inter.der), await sha256(root.der), 1, 1);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS c FROM verified_intermediates").first<{ c: number }>())?.c).toBe(1);
  });
});
