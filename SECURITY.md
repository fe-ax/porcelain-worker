# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting (Security tab > *Report a vulnerability*) on this repository. Include steps to reproduce and the affected endpoint. Expect an acknowledgement within a week.

## Threat model (summary)

**Assets**: the Anthropic API key and its spend; the device list; the admin dashboard.

**What an attacker can try, and the control:**

| Attack | Control |
|---|---|
| Call the API without the app | Every request needs an App Attest assertion from an enrolled key; unknown keys are rejected. |
| Fake or emulated device | Attestation chain is verified up to Apple's App Attest root; the app id hash must match `APP_ID_PREFIX_TEAM_BUNDLE`. Simulator/development keys are accepted only when `ENV=dev`. |
| Replay a captured request | Assertion counter must increase; challenges are single use and expire after 300 s. |
| Enrol a legitimate device and burn spend | By default enrolment gives status `pending` and only the owner approves. Per-device rate limits and a daily cap apply even to approved devices. With `AUTO_APPROVE=true` a new device is approved at once, so App Attest is the only gate; it is meant only for an app no one else can install. |
| Use the proxy as a general Claude gateway | The request is a closed schema; prompt, model, tools and limits are fixed in the Worker. Oversized or unknown fields are rejected. |
| Steal the Anthropic key | It exists only as a Worker secret, never in the repo, Terraform state, CI logs or responses. |
| Guess the admin login | `ADMIN_TOKEN` of at least 32 characters, constant-time comparison, HMAC-signed expiring session cookie; optionally Cloudflare Access. |

**Out of scope / residual risk**: with `AUTO_APPROVE=true`, anyone with a genuine install can enrol as many keys as App Attest and the per-IP challenge limit allow, each with its own daily cap; there is no global cap. A jailbroken approved device could send valid requests within the limits; a compromised Cloudflare account or GitHub secrets compromise everything they protect; revoke a device from `/admin` and rotate `ADMIN_TOKEN` / `ANTHROPIC_API_KEY` if in doubt.

The repository contains no secrets. Never commit `.dev.vars`, `.env`, tfvars or state files (all git-ignored).
