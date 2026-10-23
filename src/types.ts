// Shared types. Wire contract: ../docs/WIRE.md

export interface Env {
  DB: D1Database;
  /** "dev" allows simulator software keys and development App Attest; anything else is production. */
  ENV: string;
  /** Apple team id + "." + bundle id, e.g. "ABCDE12345.nl.feax.porcelain". */
  APP_ID_PREFIX_TEAM_BUNDLE: string;
  /** Optional Cloudflare Access audience. A non-placeholder value switches /admin to Access JWTs instead of the token login. */
  ADMIN_ACCESS_AUD: string;
  ADMIN_ACCESS_TEAM_DOMAIN: string;
  /** Secret (wrangler secret put). Never in files. */
  ANTHROPIC_API_KEY: string;
  /** Secret (wrangler secret put ADMIN_TOKEN), at least 32 characters. Logs into /admin; rotating it ends all sessions. */
  ADMIN_TOKEN: string;
}

export type DeviceStatus = "pending" | "approved" | "denied";
export type DeviceEnv = "production" | "development" | "simulator";
export type RequestKind = "label" | "lookup" | "picture" | "name";
export type Effort = "low" | "medium" | "high";
export type NutritionFieldKey =
  | "kcal" | "carbs" | "protein" | "fat" | "fibre" | "sugars" | "saturatedFat" | "salt";

export const REQUEST_KINDS: readonly RequestKind[] = ["label", "lookup", "picture", "name"];
export const NUTRITION_FIELDS: readonly NutritionFieldKey[] =
  ["kcal", "carbs", "protein", "fat", "fibre", "sugars", "saturatedFat", "salt"];

export const LIMITS = {
  maxBodyBytes: 1_500_000,
  maxImageBytes: 1_200_000,
  minImageBytes: 1_000,
  minImageSide: 64,
  maxImageSide: 4096,
  maxNameChars: 120,
  maxContextValues: 8,
  maxValueChars: 16,
  perMinute: 10,
  perDay: 200,
  challengesPerIpPerHour: 10,
  challengeTtlSeconds: 300,
  timestampSkewSeconds: 300,
  maxSearches: { min: 1, max: 10, default: 5 },
  maxResumes: 3,
  maxTokens: 16000,
} as const;

/** Stable `reason` slugs of a 400 `invalid` (WIRE.md section 6). */
export type InvalidReason =
  | "headers" | "timestamp" | "signature" | "assertion" | "attestation" | "challenge" | "rp_id"
  | "chain" | "nonce" | "schema" | "unknown_field" | "type" | "kind_fields" | "image" | "too_large"
  | "name" | "context" | "simulator_not_allowed";

export type ErrorCode =
  | "invalid" | "pending" | "denied" | "unknown_device" | "replay" | "refused" | "incomplete"
  | "unreadable" | "limit" | "upstream" | "internal";

export interface ErrorBody {
  error: ErrorCode;
  reason?: string;
  field?: string;
  retryAfter?: number;
  scope?: "minute" | "day" | "ip";
  status?: number;
}

/** A failure with a fixed HTTP status and wire body. Thrown by the helpers, caught by the router. */
export class HttpError extends Error {
  constructor(
    public readonly http: number,
    public readonly body: ErrorBody,
  ) {
    super(`${http} ${body.error}${body.reason ? ` (${body.reason})` : ""}`);
  }
}

export interface DeviceInfo {
  name: string;
  appVersion: string;
  system: string;
  env: DeviceEnv;
}

export interface EnrollBody {
  keyId: string;
  /** base64 CBOR attestation object; absent only for env "simulator". */
  attestation?: string;
  /** base64 X9.63 P-256 public key; present only for env "simulator". */
  softwareKey?: string;
  challenge: string;
  device: DeviceInfo;
}

export interface DeviceRow {
  key_id: string;
  public_key: ArrayBuffer;
  counter: number;
  status: DeviceStatus;
  env: DeviceEnv;
  name: string;
  app_version: string;
  system: string;
  country: string | null;
  first_seen: number;
  last_seen: number;
  decided_at: number | null;
  decided_by: string | null;
}

export interface RequestContext {
  name: string;
  values: { field: NutritionFieldKey; text: string }[];
}

export interface RequestOptions {
  effortLabel: Effort;
  effortSearch: Effort;
  maxSearches: number;
}

/** A validated `/v1/request` body (defaults applied, options clamped, image decoded). */
export interface ValidatedRequest {
  kind: RequestKind;
  /** Decoded JPEG; present for label, picture, name. */
  image?: Uint8Array;
  /** lookup only. */
  name?: string;
  context: RequestContext;
  options: RequestOptions;
}

/** The nutrition answer object (AIPhotoSchema), all 18 properties present. */
export interface NutritionAnswer {
  name: string | null;
  basis_grams: number | null;
  basis_unit: "g" | "ml";
  energy_kcal: number | null;
  energy_kj: number | null;
  protein: number | null;
  fat: number | null;
  saturated_fat: number | null;
  carbs: number | null;
  sugars: number | null;
  fibre: number | null;
  salt: number | null;
  sodium: number | null;
  carbs_include_fibre: boolean;
  confidence: "low" | "medium" | "high";
  note: string | null;
  portion_grams: number | null;
  portions: { name: string; grams: number }[];
}

export type RequestResponse =
  | { kind: "label" | "lookup" | "picture"; answer: NutritionAnswer }
  | { kind: "name"; answer: { name: string } };

/** The headers every /v1/request and /v1/status call carries, parsed. */
export interface AssertionHeaders {
  keyId: string;
  assertion: Uint8Array;
  counter: number;
  timestamp: number;
  nonce: string;
}

/** A Messages API call the Worker will make; built in prompts.ts, sent in claude.ts. */
export interface ClaudeCall {
  system: string;
  /** Messages API content blocks of the single user turn. */
  content: unknown[];
  webSearch: boolean;
  effort: Effort;
  maxSearches: number;
  schema: Record<string, unknown>;
}
