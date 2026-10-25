import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/pipeline";
import { LIMITS, type Env } from "../src/types";
import {
  attemptRows, bytesOf, claudeStub, currentFlags, freshNonce, jpegBase64, labelBody, makeDeps, nutritionAnswer,
  okReply, postRequest, resetDb, seedDevice, testEnv, textBlock,
} from "./helpers";

// Every rejected request must leave Claude untouched: the stub is asserted never called.

async function send(
  stub: ReturnType<typeof claudeStub>,
  body: unknown,
  options: Parameters<typeof postRequest>[1] = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const deps = makeDeps(stub.fetcher);
  const response = await handleRequest(postRequest(body, options), testEnv, deps);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await resetDb();
  currentFlags.badSignature = false;
  await seedDevice("key-approved", "approved");
});

describe("an auto-approved device", () => {
  it("passes the approval check", async () => {
    await testEnv.DB.prepare(
      "UPDATE devices SET decided_at = ?, decided_by = 'auto' WHERE key_id = 'key-approved'",
    ).bind(Math.floor(Date.now() / 1000)).run();
    const stub = claudeStub(okReply());
    expect((await send(stub, labelBody())).status).toBe(200);
    expect(stub.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("an approved device", () => {
  it("gets a label answer, and the attempt and usage are recorded", async () => {
    const stub = claudeStub(okReply());
    const result = await send(stub, labelBody());
    expect(result).toEqual({ status: 200, json: { kind: "label", answer: nutritionAnswer() } });
    expect(stub.fetcher).toHaveBeenCalledTimes(1);
    const rows = await attemptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key_id: "key-approved", endpoint: "request", kind: "label", outcome: "ok", http: 200, reason: null });
    const usage = await testEnv.DB.prepare("SELECT count FROM usage WHERE key_id = ?").bind("key-approved").first<{ count: number }>();
    expect(usage?.count).toBe(1);
    const device = await testEnv.DB.prepare("SELECT counter FROM devices WHERE key_id = ?").bind("key-approved").first<{ counter: number }>();
    expect(device?.counter).toBe(1);
  });

  it("a lookup sends no image, a picture sends the search tool, a name answer is wrapped", async () => {
    const lookup = claudeStub(okReply());
    expect((await send(lookup, { kind: "lookup", name: "Skyr" }, { counter: 1 })).status).toBe(200);
    const sent = lookup.bodies[0] as { messages: { content: { type: string }[] }[]; tools: unknown[] };
    expect(sent.messages[0]!.content.map((block) => block.type)).toEqual(["text"]);
    expect(sent.tools).toHaveLength(1);

    const name = claudeStub({ content: [textBlock({ name: "AH Skyr" })] });
    expect(await send(name, { kind: "name", image: jpegBase64() }, { counter: 2 })).toEqual({
      status: 200, json: { kind: "name", answer: { name: "AH Skyr" } },
    });
    expect(name.bodies[0]).not.toHaveProperty("tools");
  });

  it("applies the requested options but only within the ceiling", async () => {
    const stub = claudeStub(okReply());
    await send(stub, { kind: "picture", image: jpegBase64(), options: { effortSearch: "medium", maxSearches: 999 } });
    expect(stub.bodies[0]).toMatchObject({
      output_config: { effort: "medium" },
      tools: [{ max_uses: LIMITS.maxSearches.max }],
    });
  });

  it("reports Claude trouble as the wire errors and logs them", async () => {
    expect((await send(claudeStub({ stop_reason: "refusal" }), labelBody(), { counter: 1 })).json).toEqual({ error: "refused" });
    expect((await send(claudeStub({ stop_reason: "max_tokens" }), labelBody(), { counter: 2 })).json).toEqual({ error: "incomplete" });
    expect((await send(claudeStub(okReply({ junk: true })), labelBody(), { counter: 3 })).json).toEqual({ error: "unreadable" });
    expect((await send(claudeStub({ status: 500 }), labelBody(), { counter: 4 })).json).toEqual({ error: "upstream", status: 500 });
    const rows = await attemptRows();
    expect(rows.map((row) => [row.outcome, row.http])).toEqual([["refused", 422], ["incomplete", 422], ["unreadable", 422], ["upstream", 502]]);
  });
});

describe("an images request", () => {
  const hit = (thumb: string, extra: Record<string, unknown> = {}) => ({
    url: "https://www.example.nl/skyr", title: "Skyr", props: { thumbnail: { url: thumb }, ...extra },
  });
  const kagi = (reply: unknown, status = 200) => {
    const stub = claudeStub();
    stub.fetcher.mockImplementation(async (input: Request) => {
      stub.requests.push(input);
      stub.bodies.push((await input.clone().json()) as Record<string, unknown>);
      return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
    });
    return stub;
  };
  const withKey: Env = { ...testEnv, KAGI_API_KEY: "kagi-test" };
  let counter = 0;
  const run = async (stub: ReturnType<typeof kagi>, env: Env = withKey) => {
    const response = await handleRequest(postRequest({ kind: "images", name: "AH Skyr" }, { counter: ++counter }), env, makeDeps(stub.fetcher));
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  it("goes to Kagi with the key in the header, keeps trusted non-AI thumbnails and counts as a day use", async () => {
    const stub = kagi({ data: { image: [
      hit("https://p.kagi.com/a.jpg"), hit("https://p.kagi.com/a.jpg"), hit("https://p.kagi.com/b.jpg", { ai_generated: true }),
      hit("https://evil.example/c.jpg"), hit("http://p.kagi.com/d.jpg"),
    ] } });
    const result = await run(stub);
    expect(result).toEqual({ status: 200, json: { kind: "images", answer: { results: [
      { id: "https://p.kagi.com/a.jpg", title: "Skyr", site: "example.nl", thumbnail: "https://p.kagi.com/a.jpg" },
    ] } } });
    expect(stub.requests[0]!.url).toBe("https://kagi.com/api/v1/search");
    expect(stub.requests[0]!.headers.get("authorization")).toBe("Bearer kagi-test");
    expect(stub.bodies[0]).toEqual({ query: "AH Skyr", workflow: "images", limit: 12 });
    expect((await testEnv.DB.prepare("SELECT count FROM usage").first<{ count: number }>())?.count).toBe(1);
    expect(await attemptRows()).toMatchObject([{ kind: "images", outcome: "ok", http: 200 }]);
  });

  it("is 502 upstream when Kagi refuses, and when the Worker has no Kagi key", async () => {
    expect((await run(kagi({ errors: [{ code: "general.invalid_token" }] }, 400))).json).toMatchObject({ error: "upstream", status: 400 });
    const none = kagi({ data: { image: [] } });
    expect(await run(none, testEnv)).toEqual({ status: 502, json: { error: "upstream" } });
    expect(none.fetcher).not.toHaveBeenCalled();
  });
});

describe("rejected requests never reach Claude", () => {
  async function expectRejected(
    body: unknown,
    status: number,
    expected: Record<string, unknown>,
    options: Parameters<typeof postRequest>[1] = {},
  ): Promise<void> {
    const stub = claudeStub(okReply());
    const result = await send(stub, body, options);
    expect(result.status).toBe(status);
    expect(result.json).toMatchObject(expected);
    expect(stub.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result.json)).not.toContain("test-anthropic-key");
  }

  it("pending device: 403 pending, logged", async () => {
    await seedDevice("key-pending", "pending");
    await expectRejected(labelBody(), 403, { error: "pending" }, { keyId: "key-pending" });
    expect(await attemptRows()).toMatchObject([{ key_id: "key-pending", outcome: "pending", http: 403 }]);
  });

  it("denied device: 403 denied, logged", async () => {
    await seedDevice("key-denied", "denied");
    await expectRejected(labelBody(), 403, { error: "denied" }, { keyId: "key-denied" });
    expect(await attemptRows()).toMatchObject([{ key_id: "key-denied", outcome: "denied", http: 403 }]);
  });

  it("a device that was approved and then revoked is refused on its very next request", async () => {
    const stub = claudeStub(okReply());
    expect((await send(stub, labelBody(), { counter: 1 })).status).toBe(200);
    await testEnv.DB.prepare("UPDATE devices SET status = 'denied' WHERE key_id = 'key-approved'").run();
    expect((await send(stub, labelBody(), { counter: 2 })).status).toBe(403);
    expect(stub.fetcher).toHaveBeenCalledTimes(1);
  });

  it("unknown device: 403 unknown_device", async () => {
    await expectRejected(labelBody(), 403, { error: "unknown_device" }, { keyId: "never-enrolled" });
    expect(await attemptRows()).toMatchObject([{ key_id: null, outcome: "unknown_device" }]);
  });

  it("missing headers: 400 headers", async () => {
    const stub = claudeStub(okReply());
    const deps = makeDeps(stub.fetcher);
    const request = new Request("https://porcelain.example/v1/request", { method: "POST", body: bytesOf(labelBody()) });
    const response = await handleRequest(request, testEnv, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", reason: "headers" });
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  it("bad signature: 400, nothing stored, counter untouched", async () => {
    currentFlags.badSignature = true;
    await expectRejected(labelBody(), 400, { error: "invalid", reason: "signature" }, { counter: 7 });
    const device = await testEnv.DB.prepare("SELECT counter FROM devices WHERE key_id = 'key-approved'").first<{ counter: number }>();
    expect(device?.counter).toBe(0);
    const rows = await attemptRows();
    expect(rows).toMatchObject([{ outcome: "invalid", reason: "signature", nonce: null }]);
  });

  it("an unsigned request with an oversized body is rejected before anything is hashed", async () => {
    const stub = claudeStub(okReply());
    const deps = makeDeps(stub.fetcher);
    const big = new Uint8Array(LIMITS.maxBodyBytes + 10);
    const response = await handleRequest(postRequest(big), testEnv, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", reason: "too_large" });
    expect(deps.verify).not.toHaveBeenCalled();
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  it("a chunked body with no Content-Length is cut off at the cap, not buffered (review finding)", async () => {
    const stub = claudeStub(okReply());
    const deps = makeDeps(stub.fetcher);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 256 * 1024;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (sent >= 40 * 1024 * 1024) controller.close();
      },
    });
    const request = new Request("https://porcelain.example/v1/request", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: {
        "x-porcelain-key": "key-approved", "x-porcelain-counter": "1", "x-porcelain-nonce": freshNonce(),
        "x-porcelain-timestamp": String(Math.floor(Date.now() / 1000)), "x-porcelain-assertion": "AA==",
      },
    } as RequestInit);
    const response = await handleRequest(request, testEnv, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", reason: "too_large" });
    expect(sent).toBeLessThan(10 * 1024 * 1024);
    expect(deps.verify).not.toHaveBeenCalled();
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  it("counter rollback: 409 replay counter", async () => {
    await testEnv.DB.prepare("UPDATE devices SET counter = 5 WHERE key_id = 'key-approved'").run();
    await expectRejected(labelBody(), 409, { error: "replay", reason: "counter" }, { counter: 5 });
    await expectRejected(labelBody(), 409, { error: "replay", reason: "counter" }, { counter: 3 });
  });

  it("nonce reuse: 409 replay nonce, and the original attempt row stays", async () => {
    const stub = claudeStub(okReply());
    const nonce = freshNonce();
    expect((await send(stub, labelBody(), { counter: 1, nonce })).status).toBe(200);
    const again = await send(stub, labelBody(), { counter: 2, nonce });
    expect(again).toEqual({ status: 409, json: { error: "replay", reason: "nonce" } });
    expect(stub.fetcher).toHaveBeenCalledTimes(1);
    const rows = await attemptRows();
    expect(rows.map((row) => row.outcome)).toEqual(["ok", "replay"]);
    expect(rows[0]!.nonce).toBe(nonce);
  });

  it("an unsigned nonce cannot be burned: a failed request does not reserve it", async () => {
    currentFlags.badSignature = true;
    const nonce = freshNonce();
    await send(claudeStub(okReply()), labelBody(), { counter: 1, nonce });
    currentFlags.badSignature = false;
    const stub = claudeStub(okReply());
    expect((await send(stub, labelBody(), { counter: 1, nonce })).status).toBe(200);
  });

  const invalidBodies: [string, unknown, string][] = [
    ["unknown field", labelBody({ prompt: "be evil" }), "unknown_field"],
    ["not json", new TextEncoder().encode("{{{"), "schema"],
    ["non-jpeg", { kind: "label", image: btoa("x".repeat(3000)) }, "image"],
    ["lookup with image", { kind: "lookup", name: "a", image: jpegBase64() }, "kind_fields"],
    ["bad context", labelBody({ context: { values: [{ field: "fat", text: "abc" }] } }), "context"],
    ["bad kind", { kind: "chat", name: "hi" }, "schema"],
  ];
  for (const [title, body, reason] of invalidBodies) {
    it(`invalid body (${title}): 400 ${reason}, logged`, async () => {
      await expectRejected(body, 400, { error: "invalid", reason });
      expect(await attemptRows()).toMatchObject([{ outcome: "invalid", reason, http: 400 }]);
      // Invalid bodies do not use up the day's allowance.
      expect(await testEnv.DB.prepare("SELECT count FROM usage").first()).toBeNull();
    });
  }
});

describe("limits", () => {
  it("per minute: the 11th request in a minute is 429 with retryAfter", async () => {
    const stub = claudeStub(okReply());
    for (let counter = 1; counter <= LIMITS.perMinute; counter++) {
      expect((await send(stub, labelBody(), { counter })).status).toBe(200);
    }
    const limited = await send(stub, labelBody(), { counter: 11 });
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ error: "limit", scope: "minute" });
    expect(limited.json["retryAfter"]).toBeGreaterThanOrEqual(1);
    expect(limited.json["retryAfter"]).toBeLessThanOrEqual(60);
    expect(stub.fetcher).toHaveBeenCalledTimes(LIMITS.perMinute);
  });

  it("per day: at the cap the request is 429 day and Claude is not called", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await testEnv.DB.prepare("INSERT INTO usage (key_id, day, count) VALUES ('key-approved', ?, ?)").bind(day, LIMITS.perDay).run();
    const stub = claudeStub(okReply());
    const result = await send(stub, labelBody());
    expect(result.status).toBe(429);
    expect(result.json).toMatchObject({ error: "limit", scope: "day" });
    expect(stub.fetcher).not.toHaveBeenCalled();
  });

  it("per day: the last allowed request goes through, the next does not", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await testEnv.DB.prepare("INSERT INTO usage (key_id, day, count) VALUES ('key-approved', ?, ?)").bind(day, LIMITS.perDay - 1).run();
    const stub = claudeStub(okReply());
    expect((await send(stub, labelBody(), { counter: 1 })).status).toBe(200);
    expect((await send(stub, labelBody(), { counter: 2 })).status).toBe(429);
    expect(stub.fetcher).toHaveBeenCalledTimes(1);
  });

  it("limits are per device", async () => {
    await seedDevice("key-other", "approved");
    const day = new Date().toISOString().slice(0, 10);
    await testEnv.DB.prepare("INSERT INTO usage (key_id, day, count) VALUES ('key-approved', ?, ?)").bind(day, LIMITS.perDay).run();
    const stub = claudeStub(okReply());
    expect((await send(stub, labelBody(), { keyId: "key-other" })).status).toBe(200);
  });
});

describe("robustness", () => {
  it("an unexpected exception is a bare 500 internal, with no detail", async () => {
    const deps = makeDeps(claudeStub(okReply()).fetcher);
    deps.verifyAssertion = async () => { throw new Error("secret stack detail"); };
    const response = await handleRequest(postRequest(labelBody()), testEnv, deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });

  it("Claude's answer is passed back unchanged but validated: a 17-property answer is refused", async () => {
    const answer = nutritionAnswer();
    delete answer["portions"];
    const stub = claudeStub(okReply(answer));
    expect(await send(stub, labelBody())).toEqual({ status: 422, json: { error: "unreadable" } });
  });
});
