import { b64decode, bytesEqual, cborBytes, cborDecode, cborMap, derSignatureToRaw, invalid, ParseError, sha256 } from "./attest";
import { HttpError } from "./types";
import type { AssertionHeaders, DeviceRow, Env } from "./types";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Parses and range-checks the five X-Porcelain-* headers. Throws HttpError(400, invalid/headers|timestamp). */
export function parseAssertionHeaders(request: Request, nowSeconds: number): AssertionHeaders {
  const h = (n: string): string => {
    const v = request.headers.get(n);
    if (!v) throw invalid("headers");
    return v;
  };
  const keyId = h("X-Porcelain-Key");
  const assertionB64 = h("X-Porcelain-Assertion");
  const counterS = h("X-Porcelain-Counter");
  const timestampS = h("X-Porcelain-Timestamp");
  const nonce = h("X-Porcelain-Nonce");
  if (keyId.length > 64 || assertionB64.length > 4096) throw invalid("headers");
  if (!/^\d{1,10}$/.test(counterS) || !/^\d{1,12}$/.test(timestampS)) throw invalid("headers");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw invalid("headers");
  let assertion: Uint8Array;
  try {
    b64decode(keyId);
    assertion = b64decode(assertionB64);
  } catch {
    throw invalid("headers");
  }
  if (assertion.length === 0) throw invalid("headers");
  const timestamp = Number(timestampS);
  if (Math.abs(nowSeconds - timestamp) > 300) throw invalid("timestamp");
  return { keyId, assertion, counter: Number(counterS), timestamp, nonce };
}

/**
 * clientDataHash of WIRE.md 2.1:
 * SHA256("porcelain-v1\n" METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" hex(SHA256(body))).
 */
export async function clientDataHash(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  const bodyHex = hex(await sha256(body));
  return sha256(new TextEncoder().encode(`porcelain-v1\n${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHex}`));
}

/** D1 hands a BLOB column back as a number[] (not an ArrayBuffer), so accept every shape. */
async function importPoint(pub: ArrayBuffer | ArrayLike<number>): Promise<CryptoKey> {
  const bytes = pub instanceof ArrayBuffer ? new Uint8Array(pub) : Uint8Array.from(pub as ArrayLike<number>);
  return crypto.subtle.importKey("raw", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/**
 * Verifies the assertion of a stored device. Apple's scheme: the signature (ECDSA P-256 / SHA-256, DER) is over
 * SHA256(authenticatorData || clientDataHash), i.e. over Apple's nonce, which the ECDSA step hashes again (so two SHA-256 in total);
 * rpIdHash must match, and the counter in authenticatorData must be strictly greater than `device.counter` and equal
 * to the header counter. Simulator devices (env "simulator", only when env.ENV === "dev") verify a DER ECDSA
 * signature over the 32-byte clientDataHash and take the counter from the header.
 * Returns the new counter; the caller stores it. Throws HttpError (400 invalid / 409 replay).
 */
export async function verifyAssertion(
  env: Env,
  device: DeviceRow,
  headers: AssertionHeaders,
  clientDataHashBytes: Uint8Array,
): Promise<{ counter: number }> {
  // Only a production App Attest key may act outside a dev Worker: simulator keys and development-environment
  // attestations (which stay in the table if ENV was once "dev") are dead weight in production.
  if (device.env !== "production" && env.ENV !== "dev") throw invalid("simulator_not_allowed");

  let key: CryptoKey;
  try {
    key = await importPoint(device.public_key);
  } catch {
    throw invalid("assertion");
  }

  if (device.env === "simulator") {
    if (env.ENV !== "dev") throw invalid("simulator_not_allowed");
    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        derSignatureToRaw(headers.assertion, 32),
        clientDataHashBytes,
      );
    } catch {
      ok = false;
    }
    if (!ok) throw invalid("signature");
    if (headers.counter <= device.counter) throw new HttpError(409, { error: "replay", reason: "counter" });
    return { counter: headers.counter };
  }

  let signature: Uint8Array;
  let authData: Uint8Array;
  try {
    const obj = cborMap(cborDecode(headers.assertion));
    signature = cborBytes(obj.get("signature"));
    authData = cborBytes(obj.get("authenticatorData"));
    if (authData.length < 37) throw new ParseError("authData");
  } catch {
    throw invalid("assertion");
  }

  const msg = new Uint8Array(authData.length + clientDataHashBytes.length);
  msg.set(authData);
  msg.set(clientDataHashBytes, authData.length);
  // Apple: nonce = SHA256(authData || clientDataHash); the key signs the nonce with ECDSA-SHA256, which hashes it again.
  const nonce = await sha256(msg);
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSignatureToRaw(signature, 32), nonce);
  } catch {
    ok = false;
  }
  if (!ok) throw invalid("signature");

  const rp = await sha256(new TextEncoder().encode(env.APP_ID_PREFIX_TEAM_BUNDLE));
  if (!bytesEqual(authData.subarray(0, 32), rp)) throw invalid("rp_id");

  const counter = new DataView(authData.buffer, authData.byteOffset, authData.byteLength).getUint32(33, false);
  if (counter !== headers.counter) throw invalid("assertion");
  if (counter <= device.counter) throw new HttpError(409, { error: "replay", reason: "counter" });
  return { counter };
}
