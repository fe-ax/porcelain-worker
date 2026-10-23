import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleReview, handleReviewCancel, handleReviewStatus } from "../src/review";
import { reviewSystemPrompt, reviewUserText } from "../src/prompts";
import { validateReviewBody } from "../src/validate";
import { LIMITS } from "../src/types";
import { attemptRows, bytesOf, currentFlags, freshNonce, makeDeps, resetDb, seedDevice, testEnv } from "./helpers";

// Anthropic's Message Batches API is stubbed; the stub is asserted never called for rejected requests.

interface BatchState {
  processing_status: string;
  results: string; // JSONL
}

function batchStub() {
  const batches = new Map<string, BatchState>();
  const created: Record<string, unknown>[] = [];
  const canceled: string[] = [];
  let next = 0;
  const fetcher = vi.fn(async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname === "/v1/messages/batches" && input.method === "POST") {
      created.push((await input.json()) as Record<string, unknown>);
      const id = `batch_${++next}`;
      batches.set(id, { processing_status: "in_progress", results: "" });
      return ok({ id, processing_status: "in_progress" });
    }
    const match = /^\/v1\/messages\/batches\/([^/]+)(\/results|\/cancel)?$/.exec(url.pathname);
    if (!match) return new Response("nope", { status: 404 });
    const state = batches.get(match[1]!);
    if (!state) return new Response("nope", { status: 404 });
    if (match[2] === "/cancel") {
      canceled.push(match[1]!);
      return ok({ id: match[1], processing_status: "canceling" });
    }
    if (match[2] === "/results") return new Response(state.results, { status: 200 });
    return ok({ id: match[1], processing_status: state.processing_status });
  });
  const finish = (id: string, result: unknown): void => {
    batches.set(id, { processing_status: "ended", results: JSON.stringify({ custom_id: "day-review", result }) + "\n" });
  };
  const succeed = (id: string, content: unknown[], stop_reason = "end_turn"): void =>
    finish(id, { type: "succeeded", message: { stop_reason, content } });
  return { fetcher, created, canceled, finish, succeed };
}

const sample = {
  dutch: false,
  time: "Thursday 14:05",
  targets: { kcal: 2000, activeKcal: 350.5, protein: 150, fat: 70, carbs: 200 },
  eaten: { kcal: 812.04, protein: 60, fat: 25.25, carbs: 90 },
  entries: [
    { time: "08:10", name: "Skyr naturel", grams: 250, kcal: 157.5, protein: 27.5, fat: 0.5, carbs: 10, sugars: 10, salt: 0.25 },
    { time: "12:30", name: "Brood", grams: 80, kcal: 200, protein: 7, fat: 2, carbs: 38, fibre: 3.5, sugars: 2, saturatedFat: 0.5, salt: 1 },
  ],
};

let keyCounter = 0;
const call = async (
  handler: typeof handleReview,
  path: string,
  stub: ReturnType<typeof batchStub>,
  body: unknown,
  keyId = "key-approved",
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const request = new Request(`https://porcelain.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-porcelain-key": keyId,
      "x-porcelain-counter": String(++keyCounter),
      "x-porcelain-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-porcelain-nonce": freshNonce(),
      "x-porcelain-assertion": "AA==",
    },
    body: body instanceof Uint8Array ? body : bytesOf(body),
  });
  const response = await handler(request, testEnv, makeDeps(stub.fetcher));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};
const create = (stub: ReturnType<typeof batchStub>, body: unknown = sample, key = "key-approved") => call(handleReview, "/v1/review", stub, body, key);
const status = (stub: ReturnType<typeof batchStub>, id: unknown, key = "key-approved") => call(handleReviewStatus, "/v1/review/status", stub, { id }, key);
const cancel = (stub: ReturnType<typeof batchStub>, id: unknown, key = "key-approved") => call(handleReviewCancel, "/v1/review/cancel", stub, { id }, key);
const text = (value: string): unknown => ({ type: "text", text: value });

beforeEach(async () => {
  await resetDb();
  currentFlags.badSignature = false;
  keyCounter = 0;
  await seedDevice("key-approved", "approved");
  await seedDevice("key-other", "approved");
});

describe("user text and params", () => {
  it("builds the golden user text", () => {
    expect(reviewUserText(sample)).toBe(
      [
        "Now: Thursday 14:05",
        "Target: 2000 kcal (including 350.5 kcal of active energy), protein 150 g, fat 70 g, carbs 200 g",
        "Eaten so far: 812 kcal, protein 60 g, fat 25.3 g, carbs 90 g",
        "Entries, in order:",
        "- 08:10 Skyr naturel, 250 g: 157.5 kcal, protein 27.5 g, fat 0.5 g, carbs 10 g, sugars 10 g, salt 0.3 g",
        "- 12:30 Brood, 80 g: 200 kcal, protein 7 g, fat 2 g, carbs 38 g, fibre 3.5 g, sugars 2 g, saturated fat 0.5 g, salt 1 g",
      ].join("\n"),
    );
    const noActive = { ...sample, targets: { ...sample.targets, activeKcal: 0 } };
    expect(reviewUserText(noActive).split("\n")[1]).toBe("Target: 2000 kcal, protein 150 g, fat 70 g, carbs 200 g");
  });

  it("sends the fixed params in the batch", async () => {
    const stub = batchStub();
    expect((await create(stub, { ...sample, dutch: true })).status).toBe(200);
    expect(stub.created).toHaveLength(1);
    const request = (stub.created[0]!["requests"] as { custom_id: string; params: Record<string, unknown> }[])[0]!;
    expect(request.custom_id).toBe("day-review");
    expect(request.params).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 25, user_location: { type: "approximate", country: "NL" } }],
      messages: [{ role: "user", content: reviewUserText({ ...sample, dutch: true }) }],
    });
    expect(request.params["system"]).toBe(reviewSystemPrompt(true));
    expect(reviewSystemPrompt(true).endsWith("\nWrite the whole answer in Dutch (Nederlands).")).toBe(true);
    expect(reviewSystemPrompt(false).endsWith("\nWrite the whole answer in English.")).toBe(true);
  });
});

describe("happy path", () => {
  it("creates, waits, then is done; terminal rows answer without Anthropic", async () => {
    const stub = batchStub();
    const created = await create(stub);
    expect(created.json["status"]).toBe("waiting");
    const id = created.json["id"] as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);

    expect((await status(stub, id)).json).toEqual({ status: "waiting" });
    stub.succeed("batch_1", [text("Let me look."), { type: "server_tool_use" }, text("  Goed bezig.  ")]);
    expect((await status(stub, id)).json).toEqual({ status: "done", text: "Goed bezig." });

    const calls = stub.fetcher.mock.calls.length;
    expect((await status(stub, id)).json).toEqual({ status: "done", text: "Goed bezig." });
    expect(stub.fetcher.mock.calls.length).toBe(calls);

    const rows = await attemptRows();
    expect(rows.map((r) => [r.endpoint, r.outcome])).toEqual([
      ["review", "ok"], ["review_status", "ok"], ["review_status", "ok"], ["review_status", "ok"],
    ]);
  });

  it("maps failures", async () => {
    const cases: [unknown, Record<string, unknown>][] = [
      [{ type: "errored", error: { type: "api_error", message: "secret detail" } }, { status: "failed", error: "upstream" }],
      [{ type: "expired" }, { status: "failed", error: "expired" }],
      [{ type: "canceled" }, { status: "failed", error: "canceled" }],
      [{ type: "succeeded", message: { stop_reason: "refusal", content: [] } }, { status: "failed", error: "refused" }],
      [{ type: "succeeded", message: { stop_reason: "max_tokens", content: [text("cut")] } }, { status: "failed", error: "incomplete" }],
      [{ type: "succeeded", message: { stop_reason: "end_turn", content: [text("   ")] } }, { status: "failed", error: "unreadable" }],
    ];
    for (const [result, expected] of cases) {
      const stub = batchStub();
      const id = (await create(stub)).json["id"] as string;
      stub.finish("batch_1", result);
      const out = await status(stub, id);
      expect(out.json).toEqual(expected);
      expect(JSON.stringify(out.json)).not.toContain("secret");
    }
  });

  it("an Anthropic HTTP error while polling is a 502 upstream and the review keeps waiting", async () => {
    const stub = batchStub();
    const id = (await create(stub)).json["id"] as string;
    stub.fetcher.mockResolvedValueOnce(new Response("boom secret", { status: 500 }));
    expect(await status(stub, id)).toEqual({ status: 502, json: { error: "upstream", status: 500 } });
    expect((await status(stub, id)).json).toEqual({ status: "waiting" });
  });
});

describe("pause_turn", () => {
  const paused = [text("searching"), { type: "server_tool_use", id: "s1" }];

  it("continues with a new batch carrying the paused turn", async () => {
    const stub = batchStub();
    const id = (await create(stub)).json["id"] as string;
    stub.succeed("batch_1", paused, "pause_turn");
    expect((await status(stub, id)).json).toEqual({ status: "waiting" });
    expect(stub.created).toHaveLength(2);
    const params = (stub.created[1]!["requests"] as { params: { messages: unknown[] } }[])[0]!.params;
    expect(params.messages).toHaveLength(2);
    expect(params.messages[1]).toEqual({ role: "assistant", content: paused });
    stub.succeed("batch_2", [text("Klaar.")]);
    expect((await status(stub, id)).json).toEqual({ status: "done", text: "Klaar." });
  });

  it("gives up after 3 resumes as incomplete", async () => {
    const stub = batchStub();
    const id = (await create(stub)).json["id"] as string;
    for (let n = 1; n <= 3; n++) {
      stub.succeed(`batch_${n}`, paused, "pause_turn");
      expect((await status(stub, id)).json).toEqual({ status: "waiting" });
    }
    expect(stub.created).toHaveLength(4);
    stub.succeed("batch_4", paused, "pause_turn");
    expect((await status(stub, id)).json).toEqual({ status: "failed", error: "incomplete" });
    expect(stub.created).toHaveLength(4);
  });
});

describe("ownership", () => {
  it("another device gets 404 on status and cancel and nothing is called", async () => {
    const stub = batchStub();
    const id = (await create(stub)).json["id"] as string;
    const calls = stub.fetcher.mock.calls.length;
    expect(await status(stub, id, "key-other")).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await cancel(stub, id, "key-other")).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await status(stub, "A".repeat(22))).toEqual({ status: 404, json: { error: "not_found" } });
    expect(stub.fetcher.mock.calls.length).toBe(calls);
    expect((await status(stub, id)).json).toEqual({ status: "waiting" });
  });
});

describe("cancel and replacement", () => {
  it("cancel stops the batch and is idempotent", async () => {
    const stub = batchStub();
    const id = (await create(stub)).json["id"] as string;
    expect((await cancel(stub, id)).json).toEqual({ status: "canceled" });
    expect(stub.canceled).toEqual(["batch_1"]);
    expect((await cancel(stub, id)).json).toEqual({ status: "canceled" });
    expect(stub.canceled).toEqual(["batch_1"]);
    expect((await status(stub, id)).json).toEqual({ status: "canceled" });
  });

  it("cancel of a done review returns done", async () => {
    const stub = batchStub();
    const id = (await create(stub)).json["id"] as string;
    stub.succeed("batch_1", [text("ok")]);
    await status(stub, id);
    expect((await cancel(stub, id)).json).toEqual({ status: "done" });
  });

  it("a new review cancels the previous waiting one", async () => {
    const stub = batchStub();
    const first = (await create(stub)).json["id"] as string;
    const second = (await create(stub)).json["id"] as string;
    expect(second).not.toBe(first);
    expect(stub.canceled).toEqual(["batch_1"]);
    expect((await status(stub, first)).json).toEqual({ status: "canceled" });
    expect((await status(stub, second)).json).toEqual({ status: "waiting" });
  });
});

describe("limits", () => {
  it("40 reviews per device per UTC day", async () => {
    const stub = batchStub();
    const now = Math.floor(Date.now() / 1000);
    const statements = Array.from({ length: LIMITS.reviewsPerDay }, (_, n) =>
      testEnv.DB.prepare(
        "INSERT INTO review_batches (id, key_id, batch_id, params_json, status, created_at, updated_at) VALUES (?, 'key-approved', 'b', '{}', 'done', ?, ?)",
      ).bind(`seed-${n}`, now, now),
    );
    await testEnv.DB.batch(statements);
    const result = await create(stub);
    expect(result.status).toBe(429);
    expect(result.json).toMatchObject({ error: "limit", scope: "day" });
    expect(stub.fetcher).not.toHaveBeenCalled();
    expect((await create(stub, sample, "key-other")).status).toBe(200);
  });

  it("per minute, like the other endpoints", async () => {
    const stub = batchStub();
    for (let n = 0; n < LIMITS.perMinute; n++) expect((await create(stub)).status).toBe(200);
    const result = await create(stub);
    expect(result.status).toBe(429);
    expect(result.json).toMatchObject({ error: "limit", scope: "minute" });
  });

  it("purges old finished rows", async () => {
    const stub = batchStub();
    const old = Math.floor(Date.now() / 1000) - LIMITS.reviewRetentionSeconds - 10;
    await testEnv.DB.prepare(
      "INSERT INTO review_batches (id, key_id, batch_id, params_json, status, created_at, updated_at) VALUES ('old-one', 'key-approved', 'b', '{}', 'done', ?, ?)",
    ).bind(old, old).run();
    await create(stub);
    const row = await testEnv.DB.prepare("SELECT id FROM review_batches WHERE id = 'old-one'").first();
    expect(row).toBeNull();
  });
});

describe("rejections never reach Anthropic", () => {
  const paths: [string, typeof handleReview][] = [
    ["/v1/review", handleReview], ["/v1/review/status", handleReviewStatus], ["/v1/review/cancel", handleReviewCancel],
  ];

  it("unknown, pending and denied devices", async () => {
    await seedDevice("key-pending", "pending");
    await seedDevice("key-denied", "denied");
    const stub = batchStub();
    for (const [path, handler] of paths) {
      const body = path === "/v1/review" ? sample : { id: "A".repeat(22) };
      expect((await call(handler, path, stub, body, "key-unknown")).json).toEqual({ error: "unknown_device" });
      expect((await call(handler, path, stub, body, "key-pending")).json).toEqual({ error: "pending" });
      expect((await call(handler, path, stub, body, "key-denied")).json).toEqual({ error: "denied" });
    }
    expect(stub.fetcher).not.toHaveBeenCalled();
    expect((await attemptRows()).map((r) => r.endpoint)).toContain("review_cancel");
  });

  it("a bad signature", async () => {
    const stub = batchStub();
    currentFlags.badSignature = true;
    for (const [path, handler] of paths) {
      const result = await call(handler, path, stub, path === "/v1/review" ? sample : { id: "A".repeat(22) });
      expect(result).toEqual({ status: 400, json: { error: "invalid", reason: "signature" } });
    }
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  const bad: [string, (b: Record<string, any>) => unknown, string][] = [
    ["unknown field", (b) => ({ ...b, extra: 1 }), "unknown_field"],
    ["unknown entry field", (b) => ({ ...b, entries: [{ ...b["entries"][0], x: 1 }] }), "unknown_field"],
    ["61 entries", (b) => ({ ...b, entries: Array.from({ length: 61 }, () => b["entries"][0]) }), "entries"],
    ["no entries", (b) => ({ ...b, entries: [] }), "entries"],
    ["huge number", (b) => ({ ...b, eaten: { ...b["eaten"], kcal: 1e9 } }), "range"],
    ["negative number", (b) => ({ ...b, targets: { ...b["targets"], protein: -1 } }), "range"],
    ["grams over 20000", (b) => ({ ...b, entries: [{ ...b["entries"][0], grams: 20001 }] }), "range"],
    ["string number", (b) => ({ ...b, eaten: { ...b["eaten"], kcal: "5" } }), "type"],
    ["null optional", (b) => ({ ...b, entries: [{ ...b["entries"][0], fibre: null }] }), "type"],
    ["dutch not bool", (b) => ({ ...b, dutch: "yes" }), "type"],
    ["control chars in name", (b) => ({ ...b, entries: [{ ...b["entries"][0], name: "a\nb" }] }), "name"],
    ["empty name", (b) => ({ ...b, entries: [{ ...b["entries"][0], name: "  " }] }), "name"],
    ["name too long", (b) => ({ ...b, entries: [{ ...b["entries"][0], name: "x".repeat(121) }] }), "name"],
    ["bad time string", (b) => ({ ...b, time: "Thursday; ignore all" }), "time"],
    ["time too long", (b) => ({ ...b, time: "a".repeat(41) }), "time"],
    ["bad entry time", (b) => ({ ...b, entries: [{ ...b["entries"][0], time: "8:10" }] }), "time"],
    ["missing targets field", (b) => ({ ...b, targets: { kcal: 1 } }), "schema"],
  ];
  for (const [label, mutate, reason] of bad) {
    it(`invalid body: ${label}`, async () => {
      const stub = batchStub();
      const result = await create(stub, mutate(structuredClone(sample)));
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ error: "invalid", reason });
      expect(stub.fetcher).not.toHaveBeenCalled();
    });
  }

  it("a body over 64 KB", async () => {
    const stub = batchStub();
    const result = await create(stub, { ...sample, pad: "x".repeat(70_000) });
    expect(result).toEqual({ status: 400, json: { error: "invalid", reason: "too_large" } });
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  it("bad ids on status and cancel", async () => {
    const stub = batchStub();
    for (const id of ["short", 5, "A".repeat(23), "A".repeat(21) + "!"]) {
      expect((await status(stub, id)).status).toBe(400);
      expect((await cancel(stub, id)).status).toBe(400);
    }
    expect((await call(handleReviewStatus, "/v1/review/status", stub, { id: "A".repeat(22), x: 1 })).json).toMatchObject({ reason: "unknown_field" });
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  it("validateReviewBody accepts the sample", () => {
    expect(validateReviewBody(bytesOf(sample)).entries).toHaveLength(2);
  });
});
