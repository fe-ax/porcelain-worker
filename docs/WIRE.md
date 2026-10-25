# Porcelain Worker: wire contract

The exact contract between the app (`Porcelain/AI/WorkerClient.swift`, `WorkerAttest.swift`) and the Worker (this repo, name
`porcelain-api`). Both sides are written against this file; change it
first, then the code. All bodies are UTF-8 JSON, `Content-Type: application/json`, except where stated. All endpoints are `POST`.
Anything else answers 404 (405 for a wrong method on a known path). The Claude token lives only in the Worker (`ANTHROPIC_API_KEY`
secret); the app never sends a prompt, a model id or a token.

## 1. Endpoints

| Path | Purpose | Auth |
|---|---|---|
| `POST /v1/challenge` | one-time random challenge for enrolment | none (rate limited per IP) |
| `POST /v1/enroll` | register a device with its App Attest attestation; the device becomes `pending` (`approved` when `AUTO_APPROVE` is on, see 1.2) | attestation |
| `POST /v1/request` | one AI request (label, lookup, picture, name) | assertion + status `approved` |
| `POST /v1/status` | is this device pending / approved / denied (no Claude call, no daily-cap use) | assertion |
| `/admin`, `/admin/api/*` | dashboard (see `admin.ts`) | Cloudflare Access JWT, not part of the app contract |

### 1.1 `POST /v1/challenge`

Request body: `{}` (empty object; no other field allowed).
Response 200:

```json
{ "challenge": "<base64url, 32 random bytes>", "expiresAt": 1790000000 }
```

The challenge is stored in D1 (`challenges`), valid 300 s, single use (deleted when `/v1/enroll` consumes it, expired rows are purged
lazily). Rate limit: 10 per IP per hour (429).

### 1.2 `POST /v1/enroll`

Request:

```json
{
  "keyId": "<base64, the App Attest key id: SHA-256 of the public key, 32 bytes>",
  "attestation": "<base64 of the CBOR attestation object from DCAppAttestService.attestKey>",
  "challenge": "<base64url challenge from /v1/challenge>",
  "device": { "name": "Alice's iPhone", "appVersion": "1.4 (212)", "system": "iOS 27.0", "env": "production" }
}
```

`device.name` is at most 64 chars, `appVersion` at most 32, `system` at most 32, `env` is `"production" | "development" | "simulator"`
(simulator only accepted when the Worker's `ENV` var is `dev`; see 4.3). No other fields.

The `clientDataHash` given to `attestKey` is `SHA-256(challenge bytes)` (the raw 32 bytes the challenge decodes to).

Worker verification, in order (any failure: 400 `invalid` with the reason and a row in `attempts`):
1. `challenge` exists, is unexpired, unused; mark used.
2. CBOR decode; `fmt == "apple-appattest"`.
3. `x5c` chain: leaf signed by intermediate, intermediate by Apple's App Attestation Root CA (pinned in `attest.ts`), validity dates ok.
4. `nonce` in the leaf's extension `1.2.840.113635.100.8.2` equals `SHA-256(authData || SHA-256(challenge))`.
5. `keyId` equals `SHA-256` of the leaf's public key (uncompressed X9.62 point).
6. `authData.rpIdHash == SHA-256(APP_ID_PREFIX_TEAM_BUNDLE)` (var, form `TEAMID.nl.feax.porcelain`).
7. `authData.counter == 0`.
8. `aaguid` is `appattestdevelop` (padded) only when `device.env == "development"` and the Worker allows it (`ENV != "prod"` or the
   dev flag), and `appattest` + 7 zero bytes for `production`.
9. `credentialId == keyId`.

On success the device row is stored (`status = "pending"`, the public key, counter 0) and the answer is:

```json
{ "status": "pending" }
```

Exception: when the Worker var `AUTO_APPROVE` is exactly `"true"` (anything else, or missing, is off), a NEWLY enrolled device is stored
`approved` with `decided_at` = now and `decided_by = "auto"`, and the answer is `{ "status": "approved" }`. The dashboard shows it as
"approved by auto". Approved devices keep the per-device limits (4.1). Set the var to `"false"` (or remove it) to go back to manual approval;
devices already approved stay approved until revoked.

Enrolling an already known `keyId` is idempotent: no new row, 200 with the current status (a `denied` device stays denied, a `pending`
one stays pending, even with `AUTO_APPROVE` on: auto-approval applies only to the INSERT of a new row, so a revoke sticks).

### 1.3 `POST /v1/request`

Headers (section 2) plus the body of section 3. Response 200: section 5. Errors: section 6.

### 1.4 `POST /v1/status`

Headers (section 2); body `{}`. Response 200:

```json
{ "status": "pending" | "approved" | "denied" }
```

An unknown `keyId` answers 403 `unknown_device` (the app then offers Enrol). Used by Settings › AI to show the enrolment state.
A denied/pending device still gets a 200 here (so the card can say so); only `/v1/request` answers 403 for them.

## 2. Request headers (`/v1/request` and `/v1/status`)

| Header | Value |
|---|---|
| `X-Porcelain-Key` | the App Attest key id, base64 (as `keyId`) |
| `X-Porcelain-Assertion` | base64 of the CBOR assertion object (`{ signature, authenticatorData }`) from `DCAppAttestService.generateAssertion` |
| `X-Porcelain-Counter` | the counter the app expects the assertion to carry, decimal integer (redundant with `authenticatorData`, the Worker rejects a mismatch) |
| `X-Porcelain-Timestamp` | Unix seconds, decimal integer |
| `X-Porcelain-Nonce` | 16 random bytes, base64url; unique per request (idempotency key, 4.2) |

Missing or malformed header: 400 `invalid` (`reason: "headers"`). Timestamp skew over 300 s either way: 400 `invalid` (`reason: "timestamp"`).

### 2.1 The assertion client-data hash

The app calls `generateAssertion(keyId, clientDataHash:)` with

```
clientDataHash = SHA-256( "porcelain-v1" || 0x0A
                        || METHOD        || 0x0A     // "POST"
                        || PATH          || 0x0A     // "/v1/request", no query, no host
                        || TIMESTAMP     || 0x0A     // the X-Porcelain-Timestamp value, ASCII decimal
                        || NONCE         || 0x0A     // the X-Porcelain-Nonce value, ASCII
                        || hex(SHA-256(body)) )      // lowercase hex of the SHA-256 of the exact request body bytes
```

All pieces are ASCII/UTF-8 bytes, no trailing newline. The Worker rebuilds this hash from the request it received, then verifies the
assertion as Apple specifies: `nonce = SHA-256(authenticatorData || clientDataHash)`, the ECDSA P-256 signature over `nonce`
(DER, from the stored public key), `authenticatorData.rpIdHash == SHA-256(APP_ID_PREFIX_TEAM_BUNDLE)`, and
`authenticatorData.counter` strictly greater than the stored counter (then stored, in the same D1 batch as the attempt row).

## 3. `/v1/request` body: the closed schema

Unknown fields anywhere are rejected (400 `invalid`, `reason: "unknown_field"`). Body at most 1,500,000 bytes (413 is reported as 400
`invalid`, `reason: "too_large"`).

```json
{
  "kind": "label" | "lookup" | "picture" | "name",
  "image": "<base64 JPEG>",          // label, picture, name: required.  lookup: forbidden
  "name": "Skyr naturel",            // lookup: required.  other kinds: forbidden (the form's name goes in context.name)
  "context": {                       // label, lookup, picture: optional (default {name:"", values:[]}).  name: forbidden
    "name": "AH Skyr",               // <= 120 chars, may be empty
    "values": [ { "field": "kcal", "text": "63" } ]
  },
  "options": {                       // optional; each clamped, not rejected (unknown field is rejected)
    "effortLabel": "low",            // "low" | "medium" | "high", default "low"
    "effortSearch": "high",          // "low" | "medium" | "high", default "high"
    "maxSearches": 5                 // integer, clamped to 1...10, default 5
  }
}
```

Mapping to the app (mirror, do not diverge):

- `kind` = `AIDebugEntry.Kind`: `label` = `readLabel`, `lookup` = `lookUp`, `picture` = `estimate`, `name` = `nameFood`.
- `context` = `ProductContext` (`Porcelain/AI/ProductContext.swift`): `name` is `ProductContext.name`. `values` is
  `ProductContext.values`, but each value is sent as the stable field key instead of the localized `label` (the app's
  `NutritionField.displayName` is localized, and the Worker owns the prompt wording). `field` is one of
  `kcal | carbs | protein | fat | fibre | sugars | saturatedFat | salt` (`NutritionField.rawValue`), each at most once, at most 8
  entries. `text` is `ProductContext.Value.text`: the text as typed in the form, at most 16 chars, allowed characters `0-9 . , -`
  and nothing else (e.g. "0,2"). The Worker renders it to the same prompt block as `ProductContext.promptText`
  (labels in English: Energy, Carbohydrates, Protein, Fat, Fibre, Sugars, Saturated fat, Salt).
- `options` = `AIOptions` (`Porcelain/AI/AIOptions.swift`): `effortLabel` = `labelEffort`, `effortSearch` = `searchEffort`,
  `maxSearches` = `maxSearches`. The Worker applies them as requested but under its own ceiling (`effort` at most `high`; search tool
  only for `lookup` and `picture`, where `effortSearch` and `maxSearches` apply; `label` and `name` use `effortLabel`).
- The Worker alone owns: the prompts (`AIPhotoPrompt`, `AILookupPrompt`, `AIPicturePrompt`, `AINamePrompt` ported verbatim), the output
  schemas (`AIPhotoSchema`, `AINamePrompt.schema`), the model, `max_tokens` (16000), the web-search tool
  (`web_search_20250305`, user_location NL), `fallbacks`, and the `pause_turn` resume loop (at most 3 resumes).

Field rules:

- `image`: standard base64 (no data-URL prefix), decoded size 1 KB to 1,200,000 bytes. Must start with JPEG magic `FF D8 FF`, end
  with `FF D9`, and its SOF header must give width and height each between 64 and 4096 px. The app sends the ~1024 px JPEG from
  `PhotoProcessor`.
- `name` (lookup): trimmed length 1...120, no control characters, no newlines.
- `context.name`: same character rule, 0...120.
- Numbers must be JSON integers/strings exactly as typed above; wrong types are `invalid` (`reason: "type"`).

Validation order: headers and assertion first, then device status, then rate limit, then body schema. (The body is hashed into the
assertion, so a forged body cannot pass the first step.) Claude is never contacted until every check has passed.

## 4. Limits, idempotency, simulator

### 4.1 Rate limits (D1 `usage`)

Per device: 10 requests per minute, 200 per UTC day (`kind` `name` counts as one). Over: 429 `limit` with `retryAfter` seconds.
`/v1/status` does not count. Constants live in `types.ts`.

### 4.2 Idempotency

`(keyId, nonce)` is recorded in `attempts` (unique index). A repeated nonce is answered 409 `replay` (reason `nonce`) and the
original attempt row stays. A nonce is replay protection, not a retry key: the app retries a timed-out request with a NEW nonce and a
new assertion. A counter that does not increase is also 409 `replay` (reason `counter`).

### 4.3 Simulator (debug only)

The simulator has no App Attest. A debug build enrols with `device.env == "simulator"`, `attestation` omitted, and sends instead
`"softwareKey": "<base64 X9.63 P-256 public key>"` in the enrol body; requests carry an ECDSA signature (base64 DER) over the same
client-data hash in `X-Porcelain-Assertion` and `X-Porcelain-Counter` increments per request. The Worker accepts this path only
when the `ENV` var is `dev`; otherwise `/v1/enroll` answers 400 `invalid` (`reason: "simulator_not_allowed"`). For `env: "simulator"` the
`attestation` field must be absent and `softwareKey` present (and the reverse for the other two).

## 5. Response (200 from `/v1/request`)

`Content-Type: application/json`. The Worker validates the Claude answer against the output schema before returning it.

`kind` `label`, `lookup`, `picture`: the answer object of `AIPhotoSchema` (what `NutritionSuggestion.Answer.decode` parses, with the
same property names and nullability), wrapped once:

```json
{
  "kind": "lookup",
  "answer": {
    "name": "Skyr naturel", "basis_grams": 100, "basis_unit": "g",
    "energy_kcal": 63, "energy_kj": 265, "protein": 11, "fat": 0.2, "saturated_fat": 0.1,
    "carbs": 4.0, "sugars": 4.0, "fibre": null, "salt": 0.10, "sodium": null,
    "carbs_include_fibre": false, "confidence": "high", "note": null,
    "portion_grams": null, "portions": [ { "name": "pot", "grams": 150 } ]
  }
}
```

All 18 properties are present (`name`, `basis_grams`, `basis_unit`, `energy_kcal`, `energy_kj`, `protein`, `fat`, `saturated_fat`,
`carbs`, `sugars`, `fibre`, `salt`, `sodium`, `carbs_include_fibre`, `confidence`, `note`, `portion_grams`, `portions`), nullable
ones as explicit `null`. `answer` is exactly the JSON text the model produced; the app feeds `JSON.stringify(answer)` (or the
re-encoded object) to `AIClients.suggestion(fromLabelText|fromLookupText|fromPictureText:)`, so the app's own post-processing
(confidence cap, notes, `portion_grams` cleared) stays unchanged.

`kind` `name`:

```json
{ "kind": "name", "answer": { "name": "AH Skyr naturel" } }
```

(`name` is empty when the model cannot tell.)

Claude refusal (`stop_reason: "refusal"`) and cut-off answers (`max_tokens`, or 3 resumes used up) are mapped to errors, not 200:
see section 6 (`refused`, `incomplete`).

## 6. Errors

All errors: `Content-Type: application/json`, body `{ "error": "<code>", ... }`. Never contains a secret, the Claude key or Claude's
raw error body.

| HTTP | `error` | Extra fields | Meaning | App maps to |
|---|---|---|---|---|
| 400 | `invalid` | `reason` (short slug: `headers`, `timestamp`, `signature`, `assertion`, `attestation`, `challenge`, `rp_id`, `chain`, `nonce`, `schema`, `unknown_field`, `type`, `kind_fields`, `image`, `too_large`, `name`, `context`, `simulator_not_allowed`), `field?` | the request failed a check before Claude | `requestRejected(400)` |
| 403 | `pending` | | device enrolled, not approved yet | new "waiting for approval" state |
| 403 | `denied` | | device denied or revoked | "denied" state |
| 403 | `unknown_device` | | key id not enrolled | offer Enrol |
| 409 | `replay` | `reason`: `nonce` or `counter` | nonce reused or counter did not increase | retry once with a new assertion |
| 422 | `refused` | | Claude declined (`stop_reason: refusal`) | `refused` |
| 422 | `incomplete` | | answer cut off, or web search kept pausing | `incomplete` |
| 422 | `unreadable` | | Claude's answer failed the output schema | `unreadableAnswer` |
| 429 | `limit` | `retryAfter` (seconds), `scope`: `minute` or `day` or `ip` | per-device or per-IP limit | `rateLimited` |
| 502 | `upstream` | `status?` (Anthropic's HTTP status, integer only) | Claude unreachable or answered 5xx/other error | `unavailable(502)` |
| 500 | `internal` | | a bug; nothing about it is revealed | `unavailable(500)` |

403 `pending` and `denied` are logged as attempts (so they show on the dashboard); so is every `invalid`.

## 7. D1 schema (`migrations/0001_init.sql`)

```sql
CREATE TABLE devices (
  key_id        TEXT PRIMARY KEY,           -- base64 App Attest key id
  public_key    BLOB NOT NULL,              -- uncompressed X9.62 P-256 point, 65 bytes
  counter       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  env           TEXT NOT NULL CHECK (env IN ('production','development','simulator')),
  name          TEXT NOT NULL DEFAULT '',
  app_version   TEXT NOT NULL DEFAULT '',
  system        TEXT NOT NULL DEFAULT '',
  country       TEXT,                       -- request.cf.country at enrolment
  first_seen    INTEGER NOT NULL,           -- unix seconds
  last_seen     INTEGER NOT NULL,
  decided_at    INTEGER,                    -- when approved/denied
  decided_by    TEXT                        -- Access email
);

CREATE TABLE challenges (
  challenge   TEXT PRIMARY KEY,             -- base64url
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip_hash     TEXT
);

CREATE TABLE attempts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  key_id    TEXT,                           -- null when the request had no usable key id
  endpoint  TEXT NOT NULL,                  -- 'challenge' | 'enroll' | 'request' | 'status'
  kind      TEXT,                           -- label | lookup | picture | name
  outcome   TEXT NOT NULL,                  -- 'ok' | the error code of section 6
  reason    TEXT,                           -- the `reason` slug, or null
  http      INTEGER NOT NULL,
  nonce     TEXT,                           -- X-Porcelain-Nonce; unique per key when present
  country   TEXT,
  ms        INTEGER                         -- Worker time to answer
);
CREATE UNIQUE INDEX attempts_nonce ON attempts (key_id, nonce) WHERE nonce IS NOT NULL AND outcome <> 'replay';
CREATE INDEX attempts_at ON attempts (at DESC);

CREATE TABLE usage (
  key_id  TEXT NOT NULL,
  day     TEXT NOT NULL,                    -- UTC 'YYYY-MM-DD'
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);
```

Minute limiting uses `attempts` (count of `request` rows for the key in the last 60 s). The `ip` challenge limit uses `challenges.ip_hash`
(SHA-256 of IP plus a daily salt derived from the date, never the raw IP). Stored text is length-capped on write.

## 8. Not in this contract

The dashboard (`/admin`, `/admin/api/*`) is Worker-internal. Default login: `ADMIN_TOKEN` (wrangler secret, at least 32 characters; the
Worker answers 503 otherwise). `POST /admin/login` with `{"token"}` sets the `__Host-porcelain-admin` cookie (HMAC of the expiry, 12 h,
HttpOnly, Secure, SameSite=Strict); 5 failed logins per hour per hashed IP, then 429 (`admin_login_failures`, migration 0002).
`POST /admin/logout` clears it. State-changing POSTs need `x-requested-with: porcelain-admin`. Rotating `ADMIN_TOKEN` ends all sessions.
If `ADMIN_ACCESS_AUD` is set to a real Cloudflare Access audience, the Access JWT (`Cf-Access-Jwt-Assertion`) is required instead.
