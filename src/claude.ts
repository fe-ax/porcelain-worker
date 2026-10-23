import { HttpError, LIMITS, type ClaudeCall, type Env, type NutritionAnswer, type RequestKind } from "./types";
import { NUTRITION_PROPERTY_NAMES } from "./prompts";

/** Injectable fetch, so tests stub Anthropic and assert it is never hit on rejected requests. */
export type Fetcher = (input: Request) => Promise<Response>;

// Constants mirror Porcelain/AI/ClaudeClient.swift (model, version header, fallback beta).
export const MODEL = "claude-sonnet-5-5";
export const ANTHROPIC_VERSION = "2023-06-01";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 120_000;

const unreadable = (): HttpError => new HttpError(422, { error: "unreadable" });

interface Block {
  type?: unknown;
  text?: unknown;
}

interface MessageResponse {
  stop_reason?: unknown;
  content?: unknown;
}

/** The first request body: model, token cap, schema-bound output, effort, search tool, server-side fallback. */
function firstBody(call: ClaudeCall): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: LIMITS.maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.content }],
    output_config: {
      format: { type: "json_schema", schema: call.schema },
      effort: call.effort,
    },
    fallbacks: "default",
  };
  if (call.webSearch) {
    body["tools"] = [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: Math.min(LIMITS.maxSearches.max, Math.max(LIMITS.maxSearches.min, Math.trunc(call.maxSearches))),
        user_location: { type: "approximate", country: "NL" },
      },
    ];
  }
  return body;
}

/** The web search tool definition shared by every call (max_uses is clamped by the caller). */
export function webSearchTool(maxUses: number): Record<string, unknown> {
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxUses,
    user_location: { type: "approximate", country: "NL" },
  };
}

/** A request to the Anthropic API with the Worker's key and version header (no beta header). */
export function anthropicRequest(env: Env, method: "GET" | "POST", url: string, body?: unknown): Request {
  const headers: Record<string, string> = {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
    accept: method === "GET" && url.endsWith("/results") ? "application/x-jsonl, application/json" : "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function messagesRequest(env: Env, body: Record<string, unknown>): Request {
  return new Request(MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": FALLBACK_BETA,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Calls POST https://api.anthropic.com/v1/messages with the call (model, max_tokens 16000, output_config.format
 * json_schema, effort, web_search_20250305 when `webSearch`, fallbacks), resumes `pause_turn` up to 3 times, and
 * returns the last text block after the last `fallback` block, parsed as JSON.
 * Throws HttpError: 422 refused / incomplete / unreadable, 502 upstream. Anthropic's error body is never passed on.
 */
export async function callClaude(env: Env, call: ClaudeCall, fetcher: Fetcher = fetch): Promise<unknown> {
  const body = firstBody(call);
  let resumes = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetcher(messagesRequest(env, body));
    } catch {
      throw new HttpError(502, { error: "upstream" });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(502, { error: "upstream", status: response.status });
    }
    let message: MessageResponse;
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      message = parsed as MessageResponse;
    } catch {
      throw new HttpError(502, { error: "upstream", status: response.status });
    }
    const blocks: Block[] = Array.isArray(message.content) ? (message.content as Block[]) : [];
    switch (message.stop_reason) {
      case "refusal":
        throw new HttpError(422, { error: "refused" });
      case "max_tokens":
        throw new HttpError(422, { error: "incomplete" });
      case "pause_turn": {
        if (resumes >= LIMITS.maxResumes) throw new HttpError(422, { error: "incomplete" });
        resumes++;
        // The paused assistant turn is appended as-is, with no new user turn.
        (body["messages"] as unknown[]).push({ role: "assistant", content: blocks });
        continue;
      }
      default:
        return answerOf(blocks);
    }
  }
}

/** The last text block after the last `fallback` block (earlier text blocks are "Let me search..."), as JSON. */
function answerOf(blocks: Block[]): unknown {
  let start = 0;
  blocks.forEach((block, index) => {
    if (block?.type === "fallback") start = index + 1;
  });
  let text: string | undefined;
  for (const block of blocks.slice(start)) {
    if (block?.type === "text" && typeof block.text === "string") text = block.text;
  }
  if (text === undefined || text === "") throw unreadable();
  try {
    return JSON.parse(text);
  } catch {
    throw unreadable();
  }
}

// MARK: - Output validation

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (obj: Obj, keys: readonly string[]): boolean =>
  Object.keys(obj).length === keys.length && keys.every((key) => Object.hasOwn(obj, key));
const nullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const nullableText = (value: unknown, max: number): value is string | null =>
  value === null || (typeof value === "string" && value.length <= max);

/** Checks a parsed answer against the output schema for the kind. Throws HttpError(422, unreadable). */
export function parseAnswer(kind: RequestKind, json: unknown): NutritionAnswer | { name: string } {
  if (!isObject(json)) throw unreadable();
  if (kind === "name") {
    if (!hasExactly(json, ["name"]) || typeof json["name"] !== "string") throw unreadable();
    const name = json["name"].trim();
    if (name.length > 200) throw unreadable();
    return { name };
  }
  if (!hasExactly(json, NUTRITION_PROPERTY_NAMES)) throw unreadable();
  const a = json;
  const numberKeys = [
    "basis_grams", "energy_kcal", "energy_kj", "protein", "fat", "saturated_fat",
    "carbs", "sugars", "fibre", "salt", "sodium", "portion_grams",
  ] as const;
  for (const key of numberKeys) if (!nullableNumber(a[key])) throw unreadable();
  if (!nullableText(a["name"], 200) || !nullableText(a["note"], 1000)) throw unreadable();
  if (a["basis_unit"] !== "g" && a["basis_unit"] !== "ml") throw unreadable();
  if (typeof a["carbs_include_fibre"] !== "boolean") throw unreadable();
  if (a["confidence"] !== "low" && a["confidence"] !== "medium" && a["confidence"] !== "high") throw unreadable();
  const portions = a["portions"];
  if (!Array.isArray(portions) || portions.length > 20) throw unreadable();
  for (const portion of portions) {
    if (!isObject(portion) || !hasExactly(portion, ["name", "grams"])) throw unreadable();
    if (typeof portion["name"] !== "string" || portion["name"].length > 64) throw unreadable();
    if (typeof portion["grams"] !== "number" || !Number.isFinite(portion["grams"]) || portion["grams"] < 0) {
      throw unreadable();
    }
  }
  return a as unknown as NutritionAnswer;
}
