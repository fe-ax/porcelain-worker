import { describe, expect, it } from "vitest";
import { callClaude, parseAnswer, MODEL, ANTHROPIC_VERSION } from "../src/claude";
import { buildClaudeCall } from "../src/prompts";
import { HttpError, type ClaudeCall } from "../src/types";
import { claudeStub, makeJpeg, nutritionAnswer, okReply, testEnv, textBlock } from "./helpers";

const call = (over: Partial<ClaudeCall> = {}): ClaudeCall => ({
  ...buildClaudeCall({
    kind: "picture", image: makeJpeg(), context: { name: "", values: [] },
    options: { effortLabel: "low", effortSearch: "high", maxSearches: 4 },
  }),
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a failure");
}

describe("callClaude: the request", () => {
  it("sends model, token cap, schema, effort, search tool, fallbacks and the key", async () => {
    const stub = claudeStub(okReply());
    expect(await callClaude(testEnv, call(), stub.fetcher)).toEqual(nutritionAnswer());
    const [body] = stub.bodies;
    const request = stub.requests[0]!;
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(request.headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    expect(body).toMatchObject({
      model: MODEL, max_tokens: 16000, fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema" } },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4, user_location: { type: "approximate", country: "NL" } }],
    });
    expect((body as { messages: unknown[] }).messages).toHaveLength(1);
  });
  it("has no tools without web search", async () => {
    const stub = claudeStub(okReply());
    await callClaude(testEnv, call({ webSearch: false }), stub.fetcher);
    expect(stub.bodies[0]).not.toHaveProperty("tools");
  });
  it("clamps max_uses to 1...10", async () => {
    const stub = claudeStub(okReply());
    await callClaude(testEnv, call({ maxSearches: 500 }), stub.fetcher);
    expect((stub.bodies[0] as { tools: { max_uses: number }[] }).tools[0]!.max_uses).toBe(10);
  });
});

describe("callClaude: the answer", () => {
  it("takes the last text block, after the last fallback block", async () => {
    const stub = claudeStub({
      content: [
        textBlock("Let me search..."),
        { type: "server_tool_use", name: "web_search" },
        textBlock({ name: "from the declining model" }),
        { type: "fallback" },
        { type: "thinking", thinking: "..." },
        textBlock("Searching again"),
        textBlock(nutritionAnswer({ name: "Final" })),
      ],
    });
    expect(await callClaude(testEnv, call(), stub.fetcher)).toEqual(nutritionAnswer({ name: "Final" }));
  });
  it("maps refusal and max_tokens to 422", async () => {
    expect((await failure(callClaude(testEnv, call(), claudeStub({ stop_reason: "refusal" }).fetcher))).body).toEqual({ error: "refused" });
    const cut = await failure(callClaude(testEnv, call(), claudeStub({ stop_reason: "max_tokens", content: [textBlock("{")] }).fetcher));
    expect(cut.http).toBe(422);
    expect(cut.body.error).toBe("incomplete");
  });
  it("maps a missing or non-JSON answer to unreadable", async () => {
    expect((await failure(callClaude(testEnv, call(), claudeStub({ content: [] }).fetcher))).body.error).toBe("unreadable");
    expect((await failure(callClaude(testEnv, call(), claudeStub({ content: [textBlock("sorry, no")] }).fetcher))).body.error).toBe("unreadable");
  });
});

describe("callClaude: pause_turn", () => {
  it("resumes with the assistant turn appended and no new user turn", async () => {
    const paused = [{ type: "server_tool_use", id: "s1", name: "web_search" }];
    const stub = claudeStub({ stop_reason: "pause_turn", content: paused }, okReply());
    expect(await callClaude(testEnv, call(), stub.fetcher)).toEqual(nutritionAnswer());
    expect(stub.fetcher).toHaveBeenCalledTimes(2);
    const messages = (stub.bodies[1] as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content).toEqual(paused);
  });
  it("gives up after 3 resumes (4 calls) with incomplete", async () => {
    const stub = claudeStub({ stop_reason: "pause_turn", content: [{ type: "server_tool_use" }] });
    const error = await failure(callClaude(testEnv, call(), stub.fetcher));
    expect(error.body.error).toBe("incomplete");
    expect(stub.fetcher).toHaveBeenCalledTimes(4);
  });
  it("accepts an answer after exactly 3 resumes", async () => {
    const pause = { stop_reason: "pause_turn", content: [{ type: "server_tool_use" }] };
    const stub = claudeStub(pause, pause, pause, okReply());
    await callClaude(testEnv, call(), stub.fetcher);
    expect(stub.fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("callClaude: upstream trouble", () => {
  it("maps an HTTP error to 502 with only the status, never Anthropic's body", async () => {
    const error = await failure(callClaude(testEnv, call(), claudeStub({ status: 529, content: [textBlock("secret detail")] }).fetcher));
    expect(error.http).toBe(502);
    expect(error.body).toEqual({ error: "upstream", status: 529 });
  });
  it("maps a network failure to 502", async () => {
    const error = await failure(callClaude(testEnv, call(), async () => { throw new TypeError("connection reset"); }));
    expect(error.body).toEqual({ error: "upstream" });
  });
  it("maps a non-JSON reply to 502", async () => {
    const error = await failure(callClaude(testEnv, call(), async () => new Response("<html>", { status: 200 })));
    expect(error.http).toBe(502);
  });
});

describe("parseAnswer", () => {
  it("accepts a complete nutrition answer", () => {
    expect(parseAnswer("lookup", nutritionAnswer())).toEqual(nutritionAnswer());
    expect(parseAnswer("label", nutritionAnswer({ energy_kcal: null, portions: [] }))).toBeTruthy();
  });
  it("trims a name answer", () => {
    expect(parseAnswer("name", { name: "  AH Skyr " })).toEqual({ name: "AH Skyr" });
    expect(parseAnswer("name", { name: "" })).toEqual({ name: "" });
  });
  const bad: [string, "label" | "name", unknown][] = [
    ["not an object", "label", [1]],
    ["null", "label", null],
    ["missing property", "label", (() => { const a = nutritionAnswer(); delete a["note"]; return a; })()],
    ["extra property", "label", nutritionAnswer({ extra: 1 })],
    ["bad unit", "label", nutritionAnswer({ basis_unit: "oz" })],
    ["bad confidence", "label", nutritionAnswer({ confidence: "certain" })],
    ["string number", "label", nutritionAnswer({ protein: "11" })],
    ["negative number", "label", nutritionAnswer({ fat: -1 })],
    ["NaN-ish (Infinity as null)", "label", nutritionAnswer({ fat: 1e999 })],
    ["bool as string", "label", nutritionAnswer({ carbs_include_fibre: "false" })],
    ["portions not an array", "label", nutritionAnswer({ portions: "pot" })],
    ["portion extra key", "label", nutritionAnswer({ portions: [{ name: "pot", grams: 1, x: 1 }] })],
    ["portion bad grams", "label", nutritionAnswer({ portions: [{ name: "pot", grams: "150" }] })],
    ["overlong note", "label", nutritionAnswer({ note: "n".repeat(1001) })],
    ["name answer with extra", "name", { name: "x", extra: 1 }],
    ["name answer not a string", "name", { name: null }],
    ["name answer overlong", "name", { name: "x".repeat(201) }],
    ["nutrition shape for name", "name", nutritionAnswer()],
  ];
  for (const [title, kind, value] of bad) {
    it(`rejects ${title}`, () => {
      try {
        parseAnswer(kind, value);
      } catch (error) {
        expect((error as HttpError).http).toBe(422);
        expect((error as HttpError).body).toEqual({ error: "unreadable" });
        return;
      }
      throw new Error("expected a rejection");
    });
  }
});
