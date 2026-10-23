import {
  HttpError,
  LIMITS,
  NUTRITION_FIELDS,
  REQUEST_KINDS,
  type DeviceEnv,
  type Effort,
  type EnrollBody,
  type InvalidReason,
  type NutritionFieldKey,
  type RequestKind,
  type RequestOptions,
  type ReviewBody,
  type ReviewEntry,
  type ValidatedRequest,
} from "./types";

// Strict validation of what the app sends (WIRE.md sections 1.2 and 3). Closed schemas: an unknown field
// anywhere is rejected. Every failure is HttpError(400, invalid + reason). Nothing here talks to Claude.

function invalid(reason: InvalidReason, field?: string): HttpError {
  return new HttpError(400, field === undefined ? { error: "invalid", reason } : { error: "invalid", reason, field });
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses UTF-8 JSON and applies the size cap. The result is always an object (arrays, strings, null are `schema`). */
function parseObject(raw: Uint8Array): Obj {
  if (raw.byteLength > LIMITS.maxBodyBytes) throw invalid("too_large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    throw invalid("schema");
  }
  if (!isObject(value)) throw invalid("schema");
  return value;
}

/** Rejects any key of `obj` that is not in `allowed` (reports the first one as `field`). */
function closed(obj: Obj, allowed: readonly string[], prefix = ""): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid("unknown_field", prefix + key);
  }
}

// MARK: - base64

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard base64 (padding required, no whitespace, no URL alphabet). Returns null when malformed. */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

// MARK: - text rules

/** Control characters (including newlines, tabs) and the Unicode line/paragraph separators. */
const CONTROL = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]");

function plainText(value: unknown, field: string, reason: InvalidReason, min: number, max: number): string {
  if (typeof value !== "string") throw invalid("type", field);
  const text = value.trim();
  if (text.length < min || text.length > max || CONTROL.test(text)) throw invalid(reason, field);
  return text;
}

// MARK: - JPEG

/**
 * The JPEG checks alone: magic FF D8 FF, EOI FF D9 at the end, SOF width/height each in range. Walks the marker
 * segments up to the first SOF (a scan header before it means no frame header: rejected).
 */
export function checkJpeg(bytes: Uint8Array): { width: number; height: number } {
  const bad = (): HttpError => invalid("image", "image");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw bad();
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw bad();
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw bad();
    while (bytes[offset + 1] === 0xff) offset++; // fill bytes
    const marker = bytes[offset + 1]!;
    offset += 2;
    // Standalone markers have no length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0xd9) continue;
    if (marker === 0xda) throw bad(); // start of scan before any frame header
    if (offset + 2 > bytes.length) throw bad();
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2) throw bad();
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 8 || offset + 7 > bytes.length) throw bad();
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const { minImageSide: min, maxImageSide: max } = LIMITS;
      if (width < min || width > max || height < min || height > max) throw bad();
      return { width, height };
    }
    offset += length;
  }
  throw bad();
}

// MARK: - /v1/request

const REQUEST_FIELDS = ["kind", "image", "name", "context", "options"] as const;
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const VALUE_TEXT = /^[0-9.,-]+$/;

/**
 * Strict validation of the /v1/request body (WIRE.md section 3): size, closed schema (unknown fields
 * rejected), kind-specific fields, name/context rules, options clamped with defaults, image base64 + JPEG
 * magic/EOI/SOF dimensions. Throws HttpError(400, invalid + reason). Never calls Claude.
 */
export function validateRequestBody(raw: Uint8Array): ValidatedRequest {
  const body = parseObject(raw);
  closed(body, REQUEST_FIELDS);

  const kindValue = body["kind"];
  if (typeof kindValue !== "string") throw invalid("type", "kind");
  if (!REQUEST_KINDS.includes(kindValue as RequestKind)) throw invalid("schema", "kind");
  const kind = kindValue as RequestKind;

  // Kind-specific fields: label/picture/name need an image; lookup needs a name and no image;
  // name is forbidden outside lookup; context is forbidden for name.
  const needsImage = kind !== "lookup";
  if (needsImage && body["image"] === undefined) throw invalid("kind_fields", "image");
  if (!needsImage && body["image"] !== undefined) throw invalid("kind_fields", "image");
  if (kind === "lookup" && body["name"] === undefined) throw invalid("kind_fields", "name");
  if (kind !== "lookup" && body["name"] !== undefined) throw invalid("kind_fields", "name");
  if (kind === "name" && body["context"] !== undefined) throw invalid("kind_fields", "context");

  let image: Uint8Array | undefined;
  if (needsImage) {
    const encoded = body["image"];
    if (typeof encoded !== "string") throw invalid("type", "image");
    // Cheap bound before decoding: 4 base64 chars carry 3 bytes.
    if (encoded.length > Math.ceil(LIMITS.maxImageBytes / 3) * 4 + 4) throw invalid("image", "image");
    image = decodeBase64(encoded) ?? undefined;
    if (!image) throw invalid("image", "image");
    if (image.length < LIMITS.minImageBytes || image.length > LIMITS.maxImageBytes) throw invalid("image", "image");
    checkJpeg(image);
  }

  const name = kind === "lookup" ? plainText(body["name"], "name", "name", 1, LIMITS.maxNameChars) : undefined;

  const context = parseContext(body["context"]);
  const options = parseOptions(body["options"]);

  const validated: ValidatedRequest = { kind, context, options };
  if (image) validated.image = image;
  if (name !== undefined) validated.name = name;
  return validated;
}

function parseContext(value: unknown): ValidatedRequest["context"] {
  if (value === undefined) return { name: "", values: [] };
  if (!isObject(value)) throw invalid("type", "context");
  closed(value, ["name", "values"], "context.");
  const name = value["name"] === undefined ? "" : plainText(value["name"], "context.name", "context", 0, LIMITS.maxNameChars);
  const list = value["values"] === undefined ? [] : value["values"];
  if (!Array.isArray(list)) throw invalid("type", "context.values");
  if (list.length > LIMITS.maxContextValues) throw invalid("context", "context.values");
  const seen = new Set<NutritionFieldKey>();
  const values: { field: NutritionFieldKey; text: string }[] = [];
  for (const entry of list) {
    if (!isObject(entry)) throw invalid("type", "context.values");
    closed(entry, ["field", "text"], "context.values.");
    const field = entry["field"];
    const text = entry["text"];
    if (typeof field !== "string" || typeof text !== "string") throw invalid("type", "context.values");
    if (!NUTRITION_FIELDS.includes(field as NutritionFieldKey) || seen.has(field as NutritionFieldKey)) {
      throw invalid("context", "context.values.field");
    }
    if (text.length < 1 || text.length > LIMITS.maxValueChars || !VALUE_TEXT.test(text)) {
      throw invalid("context", "context.values.text");
    }
    seen.add(field as NutritionFieldKey);
    values.push({ field: field as NutritionFieldKey, text });
  }
  return { name, values };
}

function parseOptions(value: unknown): RequestOptions {
  const options: RequestOptions = {
    effortLabel: "low",
    effortSearch: "high",
    maxSearches: LIMITS.maxSearches.default,
  };
  if (value === undefined) return options;
  if (!isObject(value)) throw invalid("type", "options");
  closed(value, ["effortLabel", "effortSearch", "maxSearches"], "options.");
  for (const key of ["effortLabel", "effortSearch"] as const) {
    const effort = value[key];
    if (effort === undefined) continue;
    if (typeof effort !== "string" || !EFFORTS.includes(effort as Effort)) throw invalid("type", `options.${key}`);
    options[key] = effort as Effort;
  }
  const searches = value["maxSearches"];
  if (searches !== undefined) {
    if (typeof searches !== "number" || !Number.isInteger(searches)) throw invalid("type", "options.maxSearches");
    options.maxSearches = Math.min(LIMITS.maxSearches.max, Math.max(LIMITS.maxSearches.min, searches));
  }
  return options;
}

// MARK: - /v1/enroll and empty bodies

const DEVICE_ENVS: readonly DeviceEnv[] = ["production", "development", "simulator"];

function boundedString(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== "string") throw invalid("type", field);
  if (value.length < min || value.length > max || CONTROL.test(value)) throw invalid("schema", field);
  return value;
}

/** Validates the enrol body shape (WIRE.md 1.2) and returns it typed. Throws HttpError(400). */
export function validateEnrollBody(raw: Uint8Array): EnrollBody {
  const body = parseObject(raw);
  closed(body, ["keyId", "attestation", "softwareKey", "challenge", "device"]);
  const keyId = boundedString(body["keyId"], "keyId", 64, 1);
  const challenge = boundedString(body["challenge"], "challenge", 64, 1);
  const device = body["device"];
  if (!isObject(device)) throw invalid("type", "device");
  closed(device, ["name", "appVersion", "system", "env"], "device.");
  const env = device["env"];
  if (typeof env !== "string" || !DEVICE_ENVS.includes(env as DeviceEnv)) throw invalid("schema", "device.env");
  const info = {
    name: boundedString(device["name"], "device.name", 64),
    appVersion: boundedString(device["appVersion"], "device.appVersion", 32),
    system: boundedString(device["system"], "device.system", 32),
    env: env as DeviceEnv,
  };
  const result: EnrollBody = { keyId, challenge, device: info };
  const hasAttestation = body["attestation"] !== undefined;
  const hasSoftware = body["softwareKey"] !== undefined;
  if (info.env === "simulator") {
    if (hasAttestation) throw invalid("kind_fields", "attestation");
    if (!hasSoftware) throw invalid("kind_fields", "softwareKey");
    result.softwareKey = boundedString(body["softwareKey"], "softwareKey", 200, 1);
  } else {
    if (hasSoftware) throw invalid("kind_fields", "softwareKey");
    if (!hasAttestation) throw invalid("kind_fields", "attestation");
    // An App Attest object is a few KB; 64 KB of base64 is generous.
    result.attestation = boundedString(body["attestation"], "attestation", 65_536, 1);
  }
  return result;
}

/** `{}` only (challenge and status bodies). Throws HttpError(400, invalid/unknown_field). */
export function validateEmptyBody(raw: Uint8Array): void {
  const body = parseObject(raw);
  closed(body, []);
}

// MARK: - /v1/review

const REVIEW_TIME = /^[\p{L}0-9 :]+$/u;
const ENTRY_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const OPTIONAL_NUTRIENTS = ["fibre", "sugars", "saturatedFat", "salt"] as const;

function reviewNumber(value: unknown, field: string, max = 100_000): number {
  if (typeof value !== "number") throw invalid("type", field);
  if (!Number.isFinite(value) || value < 0 || value > max) throw invalid("range", field);
  return value;
}

function numberGroup<K extends string>(value: unknown, field: string, keys: readonly K[]): Record<K, number> {
  if (!isObject(value)) throw invalid("type", field);
  closed(value, keys, `${field}.`);
  const out = {} as Record<K, number>;
  for (const key of keys) {
    if (value[key] === undefined) throw invalid("schema", `${field}.${key}`);
    out[key] = reviewNumber(value[key], `${field}.${key}`);
  }
  return out;
}

/** Strict validation of the /v1/review body: closed schema, 64 KB, 1...60 entries, numbers finite and in range. */
export function validateReviewBody(raw: Uint8Array): ReviewBody {
  if (raw.byteLength > LIMITS.maxReviewBodyBytes) throw invalid("too_large");
  const body = parseObject(raw);
  closed(body, ["dutch", "time", "targets", "eaten", "entries"]);
  if (typeof body["dutch"] !== "boolean") throw invalid("type", "dutch");
  if (typeof body["time"] !== "string") throw invalid("type", "time");
  const time = body["time"];
  if (time.length < 1 || time.length > LIMITS.maxReviewTimeChars || !REVIEW_TIME.test(time) || time.trim() === "") {
    throw invalid("time", "time");
  }
  const targets = numberGroup(body["targets"], "targets", ["kcal", "activeKcal", "protein", "fat", "carbs"] as const);
  const eaten = numberGroup(body["eaten"], "eaten", ["kcal", "protein", "fat", "carbs"] as const);
  const list = body["entries"];
  if (!Array.isArray(list)) throw invalid("type", "entries");
  if (list.length < 1 || list.length > LIMITS.maxReviewEntries) throw invalid("entries", "entries");
  const entries: ReviewEntry[] = list.map((item, index) => {
    const at = `entries.${index}`;
    if (!isObject(item)) throw invalid("type", at);
    closed(item, ["time", "name", "grams", "kcal", "protein", "fat", "carbs", ...OPTIONAL_NUTRIENTS], `${at}.`);
    if (typeof item["time"] !== "string") throw invalid("type", `${at}.time`);
    if (!ENTRY_TIME.test(item["time"])) throw invalid("time", `${at}.time`);
    const entry: ReviewEntry = {
      time: item["time"],
      name: plainText(item["name"], `${at}.name`, "name", 1, LIMITS.maxNameChars),
      grams: reviewNumber(item["grams"], `${at}.grams`, 20_000),
      kcal: reviewNumber(item["kcal"], `${at}.kcal`),
      protein: reviewNumber(item["protein"], `${at}.protein`),
      fat: reviewNumber(item["fat"], `${at}.fat`),
      carbs: reviewNumber(item["carbs"], `${at}.carbs`),
    };
    for (const key of OPTIONAL_NUTRIENTS) {
      if (item[key] !== undefined) entry[key] = reviewNumber(item[key], `${at}.${key}`);
    }
    return entry;
  });
  return { dutch: body["dutch"], time, targets, eaten, entries };
}

const REVIEW_ID = /^[A-Za-z0-9_-]{22}$/;

/** `{"id": "<22 base64url chars>"}` (review status and cancel). */
export function validateReviewIdBody(raw: Uint8Array): string {
  const body = parseObject(raw);
  closed(body, ["id"]);
  if (typeof body["id"] !== "string") throw invalid("type", "id");
  if (!REVIEW_ID.test(body["id"])) throw invalid("id", "id");
  return body["id"];
}
