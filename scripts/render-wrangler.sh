#!/usr/bin/env bash
# Writes the real D1 database id (and optionally the per-deployment vars) into wrangler.toml.
# Usage: scripts/render-wrangler.sh <d1-database-id> [APP_ID_PREFIX_TEAM_BUNDLE] [AUTO_APPROVE true|false]
# An empty optional argument leaves the value in the file.
# CI calls it with `terraform -chdir=terraform output -raw d1_database_id`. The edit is not committed.
set -euo pipefail
id="${1:?usage: render-wrangler.sh <d1-database-id> [team.bundle]}"
[[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "not a UUID: $id" >&2; exit 1; }
cd "$(dirname "$0")/.."
tmp="$(mktemp)"
sed -E "s/^database_id = \".*\"/database_id = \"$id\"/" wrangler.toml > "$tmp"
if [[ -n "${2:-}" ]]; then
  [[ "$2" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "bad app id prefix" >&2; exit 1; }
  sed -E -i.bak "s/^APP_ID_PREFIX_TEAM_BUNDLE = \"[^\"]*\"/APP_ID_PREFIX_TEAM_BUNDLE = \"$2\"/" "$tmp" && rm -f "$tmp.bak"
fi
if [[ -n "${3:-}" ]]; then
  [[ "$3" == "true" || "$3" == "false" ]] || { echo "AUTO_APPROVE must be true or false" >&2; exit 1; }
  sed -E -i.bak "s/^AUTO_APPROVE = \"[^\"]*\"/AUTO_APPROVE = \"$3\"/" "$tmp" && rm -f "$tmp.bak"
fi
cat "$tmp" > wrangler.toml && rm -f "$tmp"
grep -n '^database_id\|^APP_ID_PREFIX\|^AUTO_APPROVE' wrangler.toml
