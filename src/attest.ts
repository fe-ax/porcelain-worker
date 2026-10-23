import { HttpError, LIMITS } from "./types";
import type { DeviceRow, EnrollBody, Env } from "./types";

// ---------------------------------------------------------------------------------------------
// Apple App Attest verification with WebCrypto only: a small CBOR decoder, a small DER/X.509
// reader, ECDSA verification for the chain and the enrolment checks of WIRE.md 1.2.
// ---------------------------------------------------------------------------------------------

/** Result of a successful attestation: what the Worker stores in `devices`. */
export interface AttestationResult {
  keyId: string;
  /** Uncompressed X9.62 P-256 point (65 bytes). */
  publicKey: Uint8Array;
  counter: 0;
}

/**
 * Pinned Apple App Attestation Root CA (PEM, P-384, valid until 2045-03-15).
 *
 * Official file from https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem, fetched 2026-10-22;
 * self-signature verified with openssl, SHA-256 fingerprint
 * 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32.
 */
export const APPLE_APP_ATTEST_ROOT_PEM: string = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

/** Re-exported for the router: a device row is created from an AttestationResult. */
export type { DeviceRow };

// ----------------------------------------------------------------------------- small helpers

export class ParseError extends Error {}

export function invalid(reason: string, field?: string): HttpError {
  return new HttpError(400, field ? { error: "invalid", reason, field } : { error: "invalid", reason });
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new ParseError("base64");
  const bin = atob(clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

function byteAt(b: Uint8Array, i: number): number {
  const v = b[i];
  if (v === undefined) throw new ParseError("eof");
  return v;
}

// ------------------------------------------------------------------------------------- CBOR

export type Cbor = number | bigint | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Decodes one CBOR item (definite lengths only; no tags or floats). Rejects trailing bytes. */
export function cborDecode(b: Uint8Array): Cbor {
  const r = { off: 0 };
  const v = cborItem(b, r, 0);
  if (r.off !== b.length) throw new ParseError("cbor trailing");
  return v;
}

function cborItem(b: Uint8Array, r: { off: number }, depth: number): Cbor {
  if (depth > 8) throw new ParseError("cbor depth");
  const ib = byteAt(b, r.off++);
  const major = ib >> 5;
  const info = ib & 0x1f;
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    throw new ParseError("cbor simple");
  }
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) n = byteAt(b, r.off++);
  else if (info === 25) n = byteAt(b, r.off++) * 256 + byteAt(b, r.off++);
  else if (info === 26) {
    n = 0;
    for (let i = 0; i < 4; i++) n = n * 256 + byteAt(b, r.off++);
  } else throw new ParseError("cbor length");
  switch (major) {
    case 0:
      return n;
    case 1:
      return -1 - n;
    case 2:
    case 3: {
      if (r.off + n > b.length) throw new ParseError("cbor eof");
      // subarray: a view, no copy (the input is never mutated); matters for the multi-KB receipt.
      const slice = b.subarray(r.off, r.off + n);
      r.off += n;
      return major === 2 ? slice : UTF8_STRICT.decode(slice);
    }
    case 4: {
      if (n > b.length) throw new ParseError("cbor array");
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) out.push(cborItem(b, r, depth + 1));
      return out;
    }
    case 5: {
      if (n > b.length) throw new ParseError("cbor map");
      const m = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = cborItem(b, r, depth + 1);
        m.set(k, cborItem(b, r, depth + 1));
      }
      return m;
    }
    default:
      throw new ParseError("cbor tag");
  }
}

export function cborMap(v: Cbor | undefined): Map<Cbor, Cbor> {
  if (!(v instanceof Map)) throw new ParseError("cbor not a map");
  return v;
}
export function cborBytes(v: Cbor | undefined): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new ParseError("cbor not bytes");
  return v;
}

// ------------------------------------------------------------------------------------- DER

interface Tlv {
  tag: number;
  /** offset of the tag byte */
  start: number;
  /** offset of the first content byte */
  vs: number;
  /** offset after the last content byte */
  end: number;
}

function tlv(b: Uint8Array, off: number): Tlv {
  const tag = byteAt(b, off);
  let len = byteAt(b, off + 1);
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3) throw new ParseError("der length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + byteAt(b, off + 2 + i);
    hdr = 2 + n;
  }
  const vs = off + hdr;
  const end = vs + len;
  if (end > b.length) throw new ParseError("der eof");
  return { tag, start: off, vs, end };
}

function kids(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let o = t.vs;
  while (o < t.end) {
    const c = tlv(b, o);
    out.push(c);
    o = c.end;
  }
  return out;
}

const content = (b: Uint8Array, t: Tlv): Uint8Array => b.subarray(t.vs, t.end);
const whole = (b: Uint8Array, t: Tlv): Uint8Array => b.subarray(t.start, t.end);
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new ParseError("missing");
  return v;
}

function oidString(b: Uint8Array, t: Tlv): string {
  if (t.tag !== 0x06) throw new ParseError("not an oid");
  const c = content(b, t);
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < c.length; i++) {
    const x = byteAt(c, i);
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) {
      if (parts.length === 0) {
        const first = Math.min(Math.floor(v / 40), 2);
        parts.push(first, v - first * 40);
      } else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

function digits(s: string, at: number, n: number): number {
  let v = 0;
  for (let i = at; i < at + n; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) throw new ParseError("time");
    v = v * 10 + c;
  }
  return v;
}

function parseTime(b: Uint8Array, t: Tlv): number {
  const s = String.fromCharCode(...content(b, t));
  let y: number;
  let o: number;
  if (t.tag === 0x17) {
    if (s.length !== 13) throw new ParseError("time");
    y = digits(s, 0, 2);
    y += y >= 50 ? 1900 : 2000;
    o = 2;
  } else if (t.tag === 0x18) {
    if (s.length !== 15) throw new ParseError("time");
    y = digits(s, 0, 4);
    o = 4;
  } else throw new ParseError("time tag");
  if (s[s.length - 1] !== "Z") throw new ParseError("time");
  return Date.UTC(y, digits(s, o, 2) - 1, digits(s, o + 2, 2), digits(s, o + 4, 2), digits(s, o + 6, 2), digits(s, o + 8, 2)) / 1000;
}

export interface Cert {
  tbs: Uint8Array;
  sigAlg: string;
  /** DER ECDSA signature */
  sig: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  spki: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** Extension values by OID, parsed on first access (only the leaf's nonce extension is ever read). */
  readonly exts: Map<string, Uint8Array>;
}

const OID_NONCE = "1.2.840.113635.100.8.2";

export function parseCert(der: Uint8Array): Cert {
  const cert = tlv(der, 0);
  if (cert.tag !== 0x30 || cert.end !== der.length) throw new ParseError("cert");
  const [tbs, alg, sigVal] = kids(der, cert);
  if (!tbs || !alg || !sigVal || tbs.tag !== 0x30 || sigVal.tag !== 0x03) throw new ParseError("cert shape");
  const t = kids(der, tbs);
  let i = 0;
  if (need(t[0]).tag === 0xa0) i = 1;
  if (alg.vs >= alg.end) throw new ParseError("missing");
  const sigAlgInner = tlv(der, alg.vs);
  const validity = kids(der, need(t[i + 3]));
  const extWrap = t[i + 6];
  let extCache: Map<string, Uint8Array> | undefined;
  return {
    tbs: whole(der, tbs),
    sigAlg: oidString(der, sigAlgInner),
    sig: content(der, sigVal).subarray(1),
    issuer: whole(der, need(t[i + 2])),
    subject: whole(der, need(t[i + 4])),
    spki: whole(der, need(t[i + 5])),
    notBefore: parseTime(der, need(validity[0])),
    notAfter: parseTime(der, need(validity[1])),
    get exts(): Map<string, Uint8Array> {
      if (!extCache) {
        extCache = new Map();
        if (extWrap && extWrap.tag === 0xa3) {
          const seq = need(kids(der, extWrap)[0]);
          for (const e of kids(der, seq)) {
            const ek = kids(der, e);
            const octet = need(ek[ek.length - 1]);
            extCache.set(oidString(der, need(ek[0])), content(der, octet));
          }
        }
      }
      return extCache;
    },
  };
}

export function pemToDer(pem: string): Uint8Array {
  return b64decode(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
}

const CURVES: Record<string, { name: "P-256" | "P-384"; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};
const HASHES: Record<string, "SHA-256" | "SHA-384" | "SHA-512"> = {
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
  "1.2.840.10045.4.3.4": "SHA-512",
};

/** Curve of an SPKI plus its public point (the BIT STRING content). */
function spkiInfo(spki: Uint8Array): { curve: { name: "P-256" | "P-384"; size: number }; point: Uint8Array } {
  const top = tlv(spki, 0);
  const [alg, bits] = kids(spki, top);
  if (!alg || !bits || bits.tag !== 0x03) throw new ParseError("spki");
  const [algOid, curveOid] = kids(spki, alg);
  if (oidString(spki, need(algOid)) !== "1.2.840.10045.2.1") throw new ParseError("not ec");
  const curve = CURVES[oidString(spki, need(curveOid))];
  if (!curve) throw new ParseError("curve");
  return { curve, point: content(spki, bits).subarray(1) };
}

/** DER ECDSA signature (SEQUENCE { r, s }) to the fixed-size r||s WebCrypto expects. */
export function derSignatureToRaw(der: Uint8Array, size: number): Uint8Array {
  const top = tlv(der, 0);
  if (top.tag !== 0x30 || top.end !== der.length) throw new ParseError("sig");
  const [r, s] = kids(der, top);
  if (!r || !s || r.tag !== 0x02 || s.tag !== 0x02) throw new ParseError("sig ints");
  const out = new Uint8Array(size * 2);
  for (const [t, off] of [[r, 0], [s, size]] as const) {
    let c = content(der, t);
    while (c.length > size && c[0] === 0) c = c.subarray(1);
    if (c.length > size || c.length === 0) throw new ParseError("sig size");
    out.set(c, off + size - c.length);
  }
  return out;
}

/**
 * Imported ECDSA verify keys by a caller-chosen id (the pinned root's PEM, or an intermediate's SHA-256). Content-keyed,
 * so a stale entry can never be wrong; bounded because an isolate may live a long time. A CryptoKey survives across
 * requests in the same isolate, so the root key is imported once per isolate rather than once per enrolment.
 */
const keyMemo = new Map<string, Promise<CryptoKey>>();

function importVerifyKey(spki: Uint8Array, memoId?: string): Promise<CryptoKey> {
  const hit = memoId === undefined ? undefined : keyMemo.get(memoId);
  if (hit) return hit;
  const { curve } = spkiInfo(spki);
  const p = crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
  if (memoId !== undefined) {
    if (keyMemo.size >= 16) keyMemo.clear();
    keyMemo.set(memoId, p);
    p.catch(() => keyMemo.delete(memoId));
  }
  return p;
}

async function verifySignedBy(child: Cert, parentSpki: Uint8Array, memoId?: string): Promise<boolean> {
  const hash = HASHES[child.sigAlg];
  if (!hash) throw new ParseError("sig alg");
  const { curve } = spkiInfo(parentSpki);
  const key = await importVerifyKey(parentSpki, memoId);
  return crypto.subtle.verify({ name: "ECDSA", hash }, key, derSignatureToRaw(child.sig, curve.size), child.tbs);
}

export async function verifyCertSignature(child: Cert, parentSpki: Uint8Array): Promise<boolean> {
  return verifySignedBy(child, parentSpki);
}

/** The pinned root, parsed and hashed once per PEM (its SHA-256 ties cache rows to the exact root they were verified against). */
const anchorMemo = new Map<string, Promise<{ cert: Cert; hash: Uint8Array }>>();

function trustAnchor(rootPem: string): Promise<{ cert: Cert; hash: Uint8Array }> {
  let p = anchorMemo.get(rootPem);
  if (!p) {
    if (anchorMemo.size >= 8) anchorMemo.clear();
    const der = pemToDer(rootPem);
    p = sha256(der).then((hash) => ({ cert: parseCert(der), hash }));
    anchorMemo.set(rootPem, p);
    p.catch(() => anchorMemo.delete(rootPem));
  }
  return p;
}

/**
 * Remembers intermediates whose signature was already verified against the pinned root. The key is the SHA-256 of the
 * intermediate's whole DER (so the very same bytes, signature included) plus the SHA-256 of the root it was verified
 * against (a changed pinned root invalidates every row). A hit only skips that one P-384 signature check.
 */
export interface ChainCache {
  has(certSha256: Uint8Array, rootSha256: Uint8Array): Promise<boolean>;
  remember(certSha256: Uint8Array, rootSha256: Uint8Array, notAfter: number, nowSeconds: number): Promise<void>;
}

/** D1-backed cache (table `verified_intermediates`, migration 0003). Errors degrade to a full verification, never to a pass. */
export function d1ChainCache(db: D1Database): ChainCache {
  return {
    async has(cert, root) {
      try {
        const row = await db
          .prepare("SELECT 1 AS ok FROM verified_intermediates WHERE cert_sha256 = ?1 AND root_sha256 = ?2")
          .bind(b64encode(cert), b64encode(root))
          .first<{ ok: number }>();
        return row !== null;
      } catch {
        return false;
      }
    },
    async remember(cert, root, notAfter, nowSeconds) {
      try {
        await db
          .prepare(
            "INSERT OR IGNORE INTO verified_intermediates (cert_sha256, root_sha256, not_after, verified_at) VALUES (?1, ?2, ?3, ?4)",
          )
          .bind(b64encode(cert), b64encode(root), notAfter, nowSeconds)
          .run();
      } catch {
        // best effort: the next enrolment simply verifies again
      }
    },
  };
}

// ------------------------------------------------------------------------------- attestation

const AAGUID_PROD = new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0]);
const AAGUID_DEV = new TextEncoder().encode("appattestdevelop");

/**
 * Verifies an App Attest attestation object (WIRE.md 1.2 steps 2-9): CBOR, x5c chain to Apple's
 * App Attestation root CA, nonce = SHA256(authData || SHA256(challenge)), keyId = SHA256(pubkey),
 * rpIdHash, counter 0, aaguid for the claimed env, credentialId == keyId.
 * Throws HttpError(400, invalid + reason) on any failure. The simulator path is `verifySoftwareKey`.
 *
 * `rootPem` exists so tests can inject their own root; the router never passes it. `cache` (see ChainCache) only skips
 * re-verifying an already verified intermediate's P-384 signature: dates, issuer names and the leaf's signature are
 * checked on every call.
 * Not checked: basicConstraints / keyUsage of the intermediate (the chain is pinned to Apple's root, which only
 * signs Apple's attestation intermediates), and the receipt (fraud metric, not needed here).
 */
export async function verifyAttestation(
  env: Env,
  body: EnrollBody,
  challengeBytes: Uint8Array,
  nowSeconds: number,
  rootPem: string = APPLE_APP_ATTEST_ROOT_PEM,
  cache?: ChainCache,
): Promise<AttestationResult> {
  if (body.device.env === "simulator" || !body.attestation) throw invalid("attestation");
  if (body.device.env === "development" && env.ENV !== "dev") throw invalid("attestation");

  let authData: Uint8Array;
  let x5c: Uint8Array[];
  try {
    const obj = cborMap(cborDecode(b64decode(body.attestation)));
    if (obj.get("fmt") !== "apple-appattest") throw new ParseError("fmt");
    authData = cborBytes(obj.get("authData"));
    const stmt = cborMap(obj.get("attStmt"));
    const chain = stmt.get("x5c");
    if (!Array.isArray(chain) || chain.length < 2 || chain.length > 4) throw new ParseError("x5c");
    x5c = chain.map(cborBytes);
  } catch {
    throw invalid("attestation");
  }

  // authData: rpIdHash(32) flags(1) counter(4) aaguid(16) credIdLen(2) credId(...)
  if (authData.length < 55) throw invalid("attestation");
  const rpIdHash = authData.subarray(0, 32);
  const counter = new DataView(authData.buffer, authData.byteOffset, authData.byteLength).getUint32(33, false);
  const aaguid = authData.subarray(37, 53);
  const credLen = (authData[53] ?? 0) * 256 + (authData[54] ?? 0);
  const credId = authData.subarray(55, 55 + credLen);
  if (credId.length !== credLen) throw invalid("attestation");

  // 3. chain: leaf -> intermediate -> pinned root. Cheap structural checks first (dates, names), then signatures.
  let leaf: Cert;
  try {
    const certs = x5c.map(parseCert);
    const anchor = await trustAnchor(rootPem);
    const ordered = [...certs, anchor.cert];
    for (const c of ordered) {
      if (nowSeconds < c.notBefore || nowSeconds > c.notAfter) throw invalid("chain");
    }
    for (let i = 0; i < certs.length; i++) {
      if (!bytesEqual(need(certs[i]).issuer, need(ordered[i + 1]).subject)) throw invalid("chain");
    }

    // The cache only applies to Apple's real shape (leaf + one intermediate). Longer chains are always fully verified.
    const inter = certs.length === 2 ? need(certs[1]) : undefined;
    const interHash = inter ? await sha256(need(x5c[1])) : undefined;
    const interTrusted = interHash && cache ? await cache.has(interHash, anchor.hash).catch(() => false) : false;
    const interMemo = interHash ? `i:${b64encode(interHash)}` : undefined;

    // The leaf is ALWAYS verified, against the intermediate presented in this very request.
    if (!(await verifySignedBy(need(certs[0]), need(ordered[1]).spki, interMemo))) throw invalid("chain");
    for (let i = 1; i < certs.length; i++) {
      if (interTrusted && i === 1) continue; // same bytes as an intermediate already verified against this exact root
      const memoId = i === certs.length - 1 ? `r:${rootPem}` : undefined;
      if (!(await verifySignedBy(need(certs[i]), need(ordered[i + 1]).spki, memoId))) throw invalid("chain");
    }
    if (inter && interHash && cache && !interTrusted) await cache.remember(interHash, anchor.hash, inter.notAfter, nowSeconds).catch(() => undefined);
    leaf = need(certs[0]);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw invalid("chain");
  }

  // 4. nonce
  let certNonce: Uint8Array;
  try {
    const ext = need(leaf.exts.get(OID_NONCE));
    const seq = tlv(ext, 0);
    const tagged = need(kids(ext, seq)[0]);
    if (tagged.tag !== 0xa1) throw new ParseError("nonce ext");
    const octet = need(kids(ext, tagged)[0]);
    if (octet.tag !== 0x04) throw new ParseError("nonce ext");
    certNonce = content(ext, octet);
  } catch {
    throw invalid("nonce");
  }
  const expected = await sha256(authData, await sha256(challengeBytes));
  if (!bytesEqual(certNonce, expected)) throw invalid("nonce");

  // 5. keyId = SHA256(leaf public key)
  let publicKey: Uint8Array;
  try {
    const info = spkiInfo(leaf.spki);
    if (info.curve.name !== "P-256" || info.point.length !== 65 || info.point[0] !== 4) throw new ParseError("key");
    publicKey = new Uint8Array(info.point);
  } catch {
    throw invalid("attestation");
  }
  const keyHash = await sha256(publicKey);
  let claimed: Uint8Array;
  try {
    claimed = b64decode(body.keyId);
  } catch {
    throw invalid("attestation");
  }
  if (!bytesEqual(keyHash, claimed)) throw invalid("attestation");

  // 6. rpId
  const rp = await sha256(new TextEncoder().encode(env.APP_ID_PREFIX_TEAM_BUNDLE));
  if (!bytesEqual(rpIdHash, rp)) throw invalid("rp_id");

  // 7. counter
  if (counter !== 0) throw invalid("attestation");

  // 8. aaguid
  const wanted = body.device.env === "development" ? AAGUID_DEV : AAGUID_PROD;
  if (!bytesEqual(aaguid, wanted)) throw invalid("attestation");

  // 9. credentialId
  if (!bytesEqual(credId, keyHash)) throw invalid("attestation");

  return { keyId: b64encode(keyHash), publicKey, counter: 0 };
}

/** Simulator enrolment (ENV=dev only): checks the P-256 point and that keyId = SHA256(point). */
export async function verifySoftwareKey(env: Env, body: EnrollBody): Promise<AttestationResult> {
  if (env.ENV !== "dev" || body.device.env !== "simulator") throw invalid("simulator_not_allowed");
  if (body.attestation !== undefined || !body.softwareKey) throw invalid("attestation");
  let point: Uint8Array;
  let claimed: Uint8Array;
  try {
    point = b64decode(body.softwareKey);
    claimed = b64decode(body.keyId);
  } catch {
    throw invalid("attestation");
  }
  if (point.length !== 65 || point[0] !== 4) throw invalid("attestation");
  try {
    await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw invalid("attestation");
  }
  const hash = await sha256(point);
  if (!bytesEqual(hash, claimed)) throw invalid("attestation");
  return { keyId: b64encode(hash), publicKey: new Uint8Array(point), counter: 0 };
}

/**
 * Consumes a challenge: deletes it (single use) and returns its bytes, only if it exists and is unexpired.
 * Throws HttpError(400, invalid/challenge) otherwise. The challenge is gone even when the attestation later fails.
 */
export async function consumeChallenge(env: Env, challenge: string, nowSeconds: number): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = b64decode(challenge);
  } catch {
    throw invalid("challenge");
  }
  if (bytes.length !== 32) throw invalid("challenge");
  const row = await env.DB.prepare("DELETE FROM challenges WHERE challenge = ?1 AND expires_at > ?2 RETURNING challenge")
    .bind(challenge, nowSeconds)
    .first<{ challenge: string }>();
  if (!row) throw invalid("challenge");
  return bytes;
}

/** Stores a fresh challenge (base64url of 32 random bytes) for LIMITS.challengeTtlSeconds. */
export async function createChallenge(
  env: Env,
  nowSeconds: number,
  ipHash: string | null,
): Promise<{ challenge: string; expiresAt: number }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const challenge = b64encode(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expiresAt = nowSeconds + LIMITS.challengeTtlSeconds;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?1").bind(nowSeconds),
    env.DB.prepare("INSERT INTO challenges (challenge, created_at, expires_at, ip_hash) VALUES (?1, ?2, ?3, ?4)").bind(
      challenge,
      nowSeconds,
      expiresAt,
      ipHash,
    ),
  ]);
  return { challenge, expiresAt };
}
