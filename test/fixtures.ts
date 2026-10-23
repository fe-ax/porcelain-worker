// Synthetic App Attest fixtures: a fake root and intermediate (P-384, like Apple's), a P-256 credential key, and the
// CBOR/DER encoders to assemble attestation and assertion objects. Test-only; nothing here is a real credential.
import { b64encode, pemToDer, sha256 } from "../src/attest";
import type { DeviceRow, EnrollBody, Env } from "../src/types";

export const NOW = 1_790_000_000;
export const APP_ID = "TEAM123456.nl.feax.porcelain";
export const enc = new TextEncoder();

// ------------------------------------------------------------------------------------- DER
export function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const hdr = n < 128 ? [tag, n] : n < 256 ? [tag, 0x81, n] : [tag, 0x82, n >> 8, n & 255];
  const out = new Uint8Array(hdr.length + n);
  out.set(hdr);
  let o = hdr.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export const seq = (...p: Uint8Array[]) => der(0x30, ...p);
export const octet = (b: Uint8Array) => der(0x04, b);
export const bitstr = (b: Uint8Array) => der(0x03, new Uint8Array([0]), b);
export const utf8 = (s: string) => der(0x0c, enc.encode(s));
export function oid(s: string): Uint8Array {
  const n = s.split(".").map(Number);
  const out: number[] = [(n[0] ?? 0) * 40 + (n[1] ?? 0)];
  for (const v of n.slice(2)) {
    const chunk: number[] = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, new Uint8Array(out));
}
export function intDer(n: number): Uint8Array {
  return der(0x02, new Uint8Array([n]));
}
function utc(sec: number): Uint8Array {
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return der(0x17, enc.encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}
const name = (cn: string) => seq(der(0x31, seq(oid("2.5.4.3"), utf8(cn))));

/** Raw r||s to DER. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const h = raw.length / 2;
  const toInt = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.subarray(i);
    if ((v[0] ?? 0) & 0x80) v = new Uint8Array([0, ...v]);
    return der(0x02, v);
  };
  return seq(toInt(raw.subarray(0, h)), toInt(raw.subarray(h)));
}

// ------------------------------------------------------------------------------------- CBOR
export function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  return [(major << 5) | 25, n >> 8, n & 255];
}
export type CborIn = string | number | Uint8Array | CborIn[] | { [k: string]: CborIn };
export function cbor(v: CborIn): Uint8Array {
  if (typeof v === "string") {
    const b = enc.encode(v);
    return new Uint8Array([...cborHead(3, b.length), ...b]);
  }
  if (typeof v === "number") return new Uint8Array(cborHead(0, v));
  if (v instanceof Uint8Array) return new Uint8Array([...cborHead(2, v.length), ...v]);
  if (Array.isArray(v)) return new Uint8Array([...cborHead(4, v.length), ...v.flatMap((x) => [...cbor(x)])]);
  const keys = Object.keys(v);
  return new Uint8Array([...cborHead(5, keys.length), ...keys.flatMap((k) => [...cbor(k), ...cbor(v[k] as CborIn)])]);
}

// ------------------------------------------------------------------------------------- certs
const ECDSA384 = { name: "ECDSA", hash: "SHA-384" } as const;

export interface Ca {
  cn: string;
  keys: CryptoKeyPair;
  der: Uint8Array;
}

async function spkiOf(pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey("spki", pub)) as ArrayBuffer);
}

async function makeCert(o: {
  subjectCn: string;
  issuerCn: string;
  subjectPub: CryptoKey;
  signer: CryptoKey;
  notBefore?: number;
  notAfter?: number;
  extensions?: Uint8Array[];
}): Promise<Uint8Array> {
  const sigAlg = seq(oid("1.2.840.10045.4.3.3"));
  const tbs = seq(
    der(0xa0, intDer(2)),
    intDer(1),
    sigAlg,
    name(o.issuerCn),
    seq(utc(o.notBefore ?? NOW - 86400), utc(o.notAfter ?? NOW + 86400 * 365)),
    name(o.subjectCn),
    await spkiOf(o.subjectPub),
    ...(o.extensions ? [der(0xa3, seq(...o.extensions))] : []),
  );
  const sig = new Uint8Array(await crypto.subtle.sign(ECDSA384, o.signer, tbs));
  return seq(tbs, sigAlg, bitstr(rawToDer(sig)));
}

export async function makeCa(cn: string, parent?: Ca, validity?: { notBefore: number; notAfter: number }): Promise<Ca> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const certDer = await makeCert({
    subjectCn: cn,
    issuerCn: parent?.cn ?? cn,
    subjectPub: keys.publicKey,
    signer: (parent?.keys ?? keys).privateKey,
    ...validity,
  });
  return { cn, keys, der: certDer };
}

export function pem(d: Uint8Array): string {
  const b = b64encode(d).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`;
}
export { pemToDer };

// ------------------------------------------------------------------------------------- attestation
export interface AttestOpts {
  rpId?: string;
  /** challenge bytes the nonce is computed from (default: the challenge sent) */
  nonceChallenge?: Uint8Array;
  counter?: number;
  aaguid?: "prod" | "dev";
  env?: "production" | "development";
  /** sign the intermediate with this CA instead of the root the Worker trusts */
  rogueIntermediate?: boolean;
  intermediateValidity?: { notBefore: number; notAfter: number };
  /** reuse this intermediate (as Apple reuses its one intermediate for many devices) */
  intermediate?: Ca;
  /** put this intermediate's certificate into x5c while the leaf stays signed by `intermediate` */
  presentedIntermediate?: Ca;
  credIdOverride?: Uint8Array;
  fmt?: string;
}

export interface Attestation {
  body: EnrollBody;
  challengeBytes: Uint8Array;
  rootPem: string;
  inter: Ca;
  keys: CryptoKeyPair;
  point: Uint8Array;
  keyIdBytes: Uint8Array;
}

export const aaguidBytes = (k: "prod" | "dev") =>
  k === "dev" ? enc.encode("appattestdevelop") : new Uint8Array([...enc.encode("appattest"), 0, 0, 0, 0, 0, 0, 0]);

let cachedRoot: Ca | undefined;
export async function testRoot(): Promise<Ca> {
  return (cachedRoot ??= await makeCa("Test App Attestation Root CA"));
}

export async function makeAttestation(o: AttestOpts = {}): Promise<Attestation> {
  const root = await testRoot();
  const signerCa = o.rogueIntermediate ? await makeCa("Rogue Root") : root;
  const inter = o.intermediate ?? (await makeCa("Test App Attestation CA 1", signerCa, o.intermediateValidity));
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer);
  const keyIdBytes = await sha256(point);
  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));

  const credId = o.credIdOverride ?? keyIdBytes;
  const rpHash = await sha256(enc.encode(o.rpId ?? APP_ID));
  const head = new Uint8Array(37);
  head.set(rpHash);
  head[32] = 0x40;
  new DataView(head.buffer).setUint32(33, o.counter ?? 0, false);
  const authData = new Uint8Array([
    ...head,
    ...aaguidBytes(o.aaguid ?? "prod"),
    credId.length >> 8,
    credId.length & 255,
    ...credId,
    // a stand-in for the COSE public key that follows in real objects
    ...cbor({ "1": 2 }),
  ]);
  const nonce = await sha256(authData, await sha256(o.nonceChallenge ?? challengeBytes));
  const nonceExt = seq(oid("1.2.840.113635.100.8.2"), octet(seq(der(0xa1, octet(nonce)))));
  const leaf = await makeCert({
    subjectCn: "leaf",
    issuerCn: inter.cn,
    subjectPub: keys.publicKey,
    signer: inter.keys.privateKey,
    extensions: [nonceExt],
  });
  const attestation = cbor({
    fmt: o.fmt ?? "apple-appattest",
    attStmt: { x5c: [leaf, (o.presentedIntermediate ?? inter).der], receipt: new Uint8Array([1, 2, 3]) },
    authData,
  });
  return {
    body: {
      keyId: b64encode(keyIdBytes),
      attestation: b64encode(attestation),
      challenge: "unused-by-verifyAttestation",
      device: { name: "Test phone", appVersion: "1.0", system: "iOS 27.0", env: o.env ?? "production" },
    },
    challengeBytes,
    rootPem: pem(root.der),
    inter,
    keys,
    point,
    keyIdBytes,
  };
}

// ------------------------------------------------------------------------------------- assertion
export function makeEnv(extra: Partial<Env> = {}, db?: D1Database): Env {
  return { DB: db as D1Database, ENV: "prod", APP_ID_PREFIX_TEAM_BUNDLE: APP_ID, ADMIN_ACCESS_AUD: "", ADMIN_ACCESS_TEAM_DOMAIN: "", ANTHROPIC_API_KEY: "", ADMIN_TOKEN: "", ...extra };
}

export function makeDevice(point: Uint8Array, over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    key_id: "k",
    public_key: point.buffer.slice(point.byteOffset, point.byteOffset + point.byteLength) as ArrayBuffer,
    counter: 0,
    status: "approved",
    env: "production",
    name: "",
    app_version: "",
    system: "",
    country: null,
    first_seen: NOW,
    last_seen: NOW,
    decided_at: null,
    decided_by: null,
    ...over,
  };
}

export async function makeAssertion(
  keys: CryptoKeyPair,
  cdh: Uint8Array,
  o: { rpId?: string; counter: number },
): Promise<Uint8Array> {
  const head = new Uint8Array(37);
  head.set(await sha256(enc.encode(o.rpId ?? APP_ID)));
  head[32] = 0x40;
  new DataView(head.buffer).setUint32(33, o.counter, false);
  const nonce = await sha256(new Uint8Array([...head, ...cdh]));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, nonce));
  return cbor({ signature: rawToDer(sig), authenticatorData: head });
}

// ------------------------------------------------------------------------------------- fake D1
/** Just enough of D1 for consumeChallenge / createChallenge. */
export function fakeD1(): { db: D1Database; rows: Map<string, { expires: number; ip: string | null }> } {
  const rows = new Map<string, { expires: number; ip: string | null }>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      if (sql.startsWith("DELETE FROM challenges WHERE challenge")) {
        const r = rows.get(String(args[0]));
        if (r && r.expires > Number(args[1])) {
          rows.delete(String(args[0]));
          return { challenge: args[0] };
        }
        return null;
      }
      throw new Error("unexpected sql " + sql);
    },
    run: async () => {
      if (sql.startsWith("DELETE FROM challenges WHERE expires_at")) {
        for (const [k, v] of rows) if (v.expires <= Number(args[0])) rows.delete(k);
      } else if (sql.startsWith("INSERT INTO challenges")) {
        rows.set(String(args[0]), { expires: Number(args[2]), ip: args[3] as string | null });
      } else throw new Error("unexpected sql " + sql);
      return {};
    },
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { run: () => Promise<unknown> }[]) => {
      for (const s of list) await s.run();
      return [];
    },
  } as unknown as D1Database;
  return { db, rows };
}
