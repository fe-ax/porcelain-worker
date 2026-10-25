# Porcelain Worker

A Cloudflare Worker (`porcelain-api`) that lets one iOS app ask Claude questions without the app holding an Anthropic key. It proxies a small, fixed set of requests (read a nutrition label, look a food up by name, estimate from a picture) for devices that proved they are the real app and that the owner approved. The wire contract is in [docs/WIRE.md](docs/WIRE.md).

A fourth request family, the **day review** (`/v1/review`, `/v1/review/status`, `/v1/review/cancel`), takes structured day data, owns its prompt and runs it through Anthropic's Message Batches API; see WIRE.md section 9.

## Architecture

1. The app asks `POST /v1/challenge` for a one-time challenge, then enrols with an Apple **App Attest** attestation (`/v1/enroll`). The Worker verifies the certificate chain to Apple's root, the nonce, the app id hash (`APP_ID_PREFIX_TEAM_BUNDLE`) and the key id.
2. A new device is `pending`. The owner approves or denies it in the `/admin` dashboard (or, with `AUTO_APPROVE` on, it is approved at once; see Configuration).
3. Each `/v1/request` carries an App Attest **assertion** (signature + monotonic counter) over the request body hash.
4. The body is a closed schema (kind, image, product context, options). The Worker builds the prompt, model, tools and limits itself.
5. The Worker calls the Anthropic API with `ANTHROPIC_API_KEY` (a Worker secret) and returns only the parsed answer.
6. State (devices, challenges, attempts, cached Apple intermediates) lives in a D1 database bound as `DB`.
7. Infrastructure is split in two. **Terraform** (`terraform/`) owns the D1 database and the custom domain; state is in a Cloudflare R2 bucket.
8. **wrangler** deploys the Worker script and D1 migrations. It is wrangler's job, not Terraform's, because the script's bundle (TypeScript, `nodejs_compat`, bindings, migrations) is what wrangler builds natively, and Terraform would need a pre-built bundle plus a re-declaration of every binding. Secrets also stay out of Terraform state this way.
9. GitHub Actions run CI on every push and deploy on `main`: Terraform apply, render `wrangler.toml` from the Terraform output, migrations, `wrangler deploy`.
10. Secrets (`ANTHROPIC_API_KEY`, `ADMIN_TOKEN`) are set once with `wrangler secret put` and are never in files, Terraform or CI.

## Security model

- **App Attest**: only a genuine install of the configured app (team id + bundle id) on a real Apple device can enrol; every request is signed by a key in the device's Secure Enclave, with a counter that rejects replays.
- **Manual approval** (the default): enrolment alone grants nothing. Only an `approved` device reaches Claude; the owner can revoke at any time. `AUTO_APPROVE=true` drops this step, leaving App Attest as the only gate: use it only while no one else can install the app.
- **Fixed request**: the app can never send a prompt, model id or tool list. Bodies are validated against a closed schema with size limits, per-device rate limits and a daily cap.
- **Admin login**: `/admin` uses an `ADMIN_TOKEN` login (HMAC-signed session cookie, at least 32 characters; rotating the token ends all sessions), or Cloudflare Access JWTs if `ADMIN_ACCESS_AUD` / `ADMIN_ACCESS_TEAM_DOMAIN` hold real values.

See [SECURITY.md](SECURITY.md) for reporting and the threat model.

## Layout

```
src/            Worker code (TypeScript)        test/        vitest (workers pool), 245 tests
migrations/     D1 schema                       docs/WIRE.md the wire contract
terraform/      D1 + custom domain + R2 state   scripts/     bootstrap-state.sh, render-wrangler.sh
.github/        ci.yml, deploy.yml
```

## Configuration (per deployment)

Per-deployment values live outside the code: GitHub repository **variables** for CI (written into `wrangler.toml` or passed to Terraform at deploy time), `TF_VAR_*` or `-var` when you run Terraform yourself. The values committed in `wrangler.toml` are placeholders and safe defaults.

| Setting | Where | Meaning |
|---|---|---|
| `APP_ID_PREFIX_TEAM_BUNDLE` | GitHub variable `APP_ID_PREFIX_TEAM_BUNDLE` (rendered into wrangler.toml) | Apple team id + `.` + bundle id, e.g. `ABCDE12345.com.example.app`. App Attest only accepts this app. |
| `AUTO_APPROVE` | GitHub variable `AUTO_APPROVE` (rendered into wrangler.toml; default `false`) | `true` approves a newly enrolled device at once. Every genuine install of the app can then spend your Anthropic key (each within the per-device limits, and one phone can enrol several keys), so keep it `false` once the app is distributed beyond your own devices. |
| `ENV` | wrangler.toml | `prod`; `dev` additionally accepts simulator software keys and development App Attest. Never `dev` in production. |
| `ADMIN_ACCESS_AUD`, `ADMIN_ACCESS_TEAM_DOMAIN` | wrangler.toml | Optional Cloudflare Access. Leave the `placeholder` values to use the token login. |
| `account_id` | Terraform (`TF_VAR_account_id`, from the `CLOUDFLARE_ACCOUNT_ID` secret in CI) | Your Cloudflare account. |
| `zone_name`, `hostname` | GitHub variables `ZONE_NAME`, `WORKER_HOSTNAME` (`TF_VAR_zone_name`, `TF_VAR_hostname`) | Zone and hostname of the Worker, e.g. `example.com` and `api.example.com`. Required. |
| `worker_name`, `database_name` | terraform/variables.tf and wrangler.toml | Keep both in sync. |

### Changing the Apple team id or bundle id

Change the GitHub repository **variable** `APP_ID_PREFIX_TEAM_BUNDLE` (for example when moving to a paid developer team) and run the Deploy workflow; it is written into `wrangler.toml` at deploy time (the value in the file is only a placeholder). Devices enrolled under the old id stay in D1 but their attestations were bound to the old id, so enrol them again.

## One-time setup

1. **Enable R2** in the Cloudflare dashboard (R2 needs a payment method on file; the free allowance is ample). The Worker itself needs the Workers Paid plan only if you need the CPU limits it was built for.
2. **Bootstrap the state bucket** (once, from your machine, with a token that may edit R2): `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm ci && scripts/bootstrap-state.sh`. It creates `porcelain-worker-tfstate` and is safe to re-run.
3. **Create an R2 API token** (R2 > Manage API tokens) with *Object Read & Write* on that bucket only. Its access key id and secret are the two R2 secrets below.
4. **Create a Cloudflare API token** (My Profile > API Tokens > Custom) with:
   - Account: *Workers Scripts: Edit*, *D1: Edit*, *Workers R2 Storage: Edit* (only needed for the bootstrap; the CI token can do without it)
   - Zone: *Zone: Read*, *Workers Routes: Edit* (needed for the custom domain), resource scoped to your zone, plus *DNS: Edit* if the custom domain has to create the record.
   Adjust if `terraform plan` reports a permission error; the exact set the provider needs can differ by version.
5. **GitHub repository secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (the workflow maps the last two to `AWS_*` for the S3 backend). **Variables**: `APP_ID_PREFIX_TEAM_BUNDLE`, `ZONE_NAME`, `WORKER_HOSTNAME`, and optionally `AUTO_APPROVE`.
6. **Worker secrets** (once, locally, never in CI):
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put KAGI_API_KEY       # optional: Find picture (kind "images"); without it those requests answer 502
   npx wrangler secret put ADMIN_TOKEN      # 32+ random characters, e.g. `openssl rand -base64 36`
   ```
   `wrangler deploy` keeps them. `secret put` needs the Worker to exist: on a brand-new deployment run the first deploy below, then set the secrets.
7. **First deploy**: push to `main` (or run the *Deploy* workflow). On a brand-new account the custom domain needs the Worker script to exist first. If the first run fails on the domain, run `npx wrangler deploy` once locally (after `scripts/render-wrangler.sh <d1 id>`), then re-run the workflow.

### Adopting existing resources

`terraform/imports.tf` has config-driven `import` blocks for the D1 database and the custom domain, with ids from the variables `import_d1_database_id` and `import_custom_domain_id`. Both default to empty, which imports nothing: a fresh deployment simply creates the resources. To adopt resources you made by hand, set them for the first apply (`TF_VAR_import_d1_database_id`, `TF_VAR_import_custom_domain_id`).

The import id format used is `<account_id>/<id>` for both resources. This was written from knowledge of the v5 provider, not tested against the API: check the first `terraform plan` shows "will be imported" with no changes (or only harmless ones) before applying. Once in state the blocks are no-ops and the variables can be cleared.

State locking: the S3 backend's `use_lockfile` is not enabled because R2's conditional-write support for it is not verified here. Instead the deploy workflow's `concurrency: deploy` group serialises runs. Do not run `terraform apply` locally while a deploy runs.

## Local development

```
nvm use                      # Node 24 LTS (.nvmrc)
npm ci
npm run typecheck && npm test
printf 'ENV=dev\nANTHROPIC_API_KEY=sk-ant-...\nADMIN_TOKEN=%s\n' "$(openssl rand -base64 36)" > .dev.vars   # git-ignored
npm run migrate:local && npm run dev
```

Tests use a simulated D1 and test-only values; they need no secrets or network. For Terraform, `terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate`.

## Reading CPU time

Verifying App Attest chains (P-256/P-384 ECDSA) is the expensive part, which is why verified Apple intermediates are cached in D1. To see what a request costs: Cloudflare dashboard > Workers & Pages > `porcelain-api` > *Metrics* (CPU time percentiles per request), or run `npx wrangler tail porcelain-api --format pretty` and watch the per-invocation CPU/wall time; GraphQL Analytics (`workersInvocationsAdaptive`, field `cpuTimeP50/P99`) gives history. Enrolment is the heavy request; `/v1/request` should be far below the plan's CPU limit.

## License

[MIT](LICENSE).
