import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { PipelineDeps } from "../src/pipeline";
import { HttpError, type DeviceStatus, type Env } from "../src/types";

export const testEnv = env as unknown as Env;

/** A structurally valid JPEG (SOI, padding comment, SOF0 with the given size, EOI). Not decodable, not meant to be. */
export function makeJpeg(width = 800, height = 600, padding = 2000): Uint8Array {
  const comment = new Uint8Array(4 + padding);
  comment.set([0xff, 0xfe, (padding + 2) >> 8, (padding + 2) & 0xff]);
  const sof = new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, ...comment, ...sof, 0xff, 0xd9]);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const jpegBase64 = (): string => toBase64(makeJpeg());
export const bytesOf = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

export async function resetDb(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM attempts"),
    testEnv.DB.prepare("DELETE FROM review_batches"),
    testEnv.DB.prepare("DELETE FROM usage"),
    testEnv.DB.prepare("DELETE FROM devices"),
    testEnv.DB.prepare("DELETE FROM challenges"),
    testEnv.DB.prepare("DELETE FROM admin_login_failures"),
  ]);
}

export async function seedDevice(
  keyId: string,
  status: DeviceStatus = "approved",
  counter = 0,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await testEnv.DB.prepare(
    `INSERT INTO devices (key_id, public_key, counter, status, env, name, app_version, system, country, first_seen, last_seen)
     VALUES (?, ?, ?, ?, 'simulator', 'Test iPhone', '1.0 (1)', 'iOS 27.0', 'NL', ?, ?)`,
  )
    .bind(keyId, new Uint8Array(65), counter, status, now, now)
    .run();
}

export async function attemptRows(): Promise<
  { key_id: string | null; endpoint: string; kind: string | null; outcome: string; reason: string | null; http: number; nonce: string | null }[]
> {
  const rows = await testEnv.DB.prepare(
    "SELECT key_id, endpoint, kind, outcome, reason, http, nonce FROM attempts ORDER BY id",
  ).all<{ key_id: string | null; endpoint: string; kind: string | null; outcome: string; reason: string | null; http: number; nonce: string | null }>();
  return rows.results;
}

/** The answer a label read would produce; all 18 properties. */
export function nutritionAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Skyr naturel", basis_grams: 100, basis_unit: "g", energy_kcal: 63, energy_kj: 265, protein: 11,
    fat: 0.2, saturated_fat: 0.1, carbs: 4, sugars: 4, fibre: null, salt: 0.1, sodium: null,
    carbs_include_fibre: false, confidence: "high", note: null, portion_grams: null,
    portions: [{ name: "pot", grams: 150 }],
    ...overrides,
  };
}

export interface ClaudeReply {
  status?: number;
  stop_reason?: string;
  content?: unknown[];
}

export const textBlock = (value: unknown): unknown => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value),
});

/** A fetcher standing in for api.anthropic.com. Replies are consumed in order; the last one repeats. */
export function claudeStub(...replies: ClaudeReply[]) {
  const bodies: Record<string, unknown>[] = [];
  const requests: Request[] = [];
  let index = 0;
  const fetcher = vi.fn(async (input: Request): Promise<Response> => {
    requests.push(input);
    bodies.push((await input.clone().json()) as Record<string, unknown>);
    const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
    return new Response(
      JSON.stringify({ stop_reason: reply.stop_reason ?? "end_turn", content: reply.content ?? [] }),
      { status: reply.status ?? 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetcher, bodies, requests };
}

export const okReply = (answer: unknown = nutritionAnswer()): ClaudeReply => ({ content: [textBlock(answer)] });

/** Fake assertion layer: the signature is "valid" unless the request says otherwise. attest/assert have their own tests. */
export function makeDeps(fetcher: PipelineDeps["fetcher"]): PipelineDeps & {
  verify: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(async (_env: Env, _device: unknown, headers: { counter: number }, _hash: Uint8Array) => {
    if (currentFlags.badSignature) throw new HttpError(400, { error: "invalid", reason: "signature" });
    return { counter: headers.counter };
  });
  return {
    fetcher,
    now: () => Date.now(),
    verify,
    parseAssertionHeaders: (request) => {
      const get = (name: string): string => request.headers.get(name) ?? "";
      const keyId = get("x-porcelain-key");
      const nonce = get("x-porcelain-nonce");
      if (!keyId || !nonce) throw new HttpError(400, { error: "invalid", reason: "headers" });
      return {
        keyId,
        assertion: new Uint8Array([1]),
        counter: Number(get("x-porcelain-counter")),
        timestamp: Number(get("x-porcelain-timestamp")),
        nonce,
      };
    },
    clientDataHash: async () => new Uint8Array(32),
    verifyAssertion: verify as unknown as PipelineDeps["verifyAssertion"],
  };
}

export const currentFlags = { badSignature: false };

let nonceCounter = 0;
export const freshNonce = (): string => `nonce-${++nonceCounter}-${Math.random().toString(36).slice(2)}`;

export function postRequest(
  body: Uint8Array | unknown,
  options: { keyId?: string; counter?: number; nonce?: string; headers?: Record<string, string> } = {},
): Request {
  const raw = body instanceof Uint8Array ? body : bytesOf(body);
  return new Request("https://porcelain.example/v1/request", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-porcelain-key": options.keyId ?? "key-approved",
      "x-porcelain-counter": String(options.counter ?? 1),
      "x-porcelain-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-porcelain-nonce": options.nonce ?? freshNonce(),
      "x-porcelain-assertion": "AA==",
      ...options.headers,
    },
    body: raw,
  });
}

export const labelBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "label",
  image: jpegBase64(),
  ...extra,
});
