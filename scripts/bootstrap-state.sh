#!/usr/bin/env bash
# ONE-TIME: creates the R2 bucket that holds the Terraform state. Idempotent.
# Needs: R2 enabled on the account, and CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment
# (or `wrangler login`). Terraform cannot create its own state bucket, hence this script.
set -euo pipefail
cd "$(dirname "$0")/.."
bucket="${1:-porcelain-worker-tfstate}"
if npx --no-install wrangler r2 bucket list | grep -qE "^name:[[:space:]]+${bucket}$"; then
  echo "bucket ${bucket} already exists"
else
  npx --no-install wrangler r2 bucket create "${bucket}"
fi
echo "Next: create an R2 API token (Object Read & Write on ${bucket}) and store its keys as the GitHub secrets R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY."
