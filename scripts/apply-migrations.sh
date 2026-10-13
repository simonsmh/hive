#!/usr/bin/env bash
# Applies supabase/migrations/*.sql in filename order, one transaction per file.
# Requires DATABASE_URL (a Supabase-compatible Postgres with pg_cron, pgmq and supabase_vault).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s nullglob
files=("$root"/supabase/migrations/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no migrations found" >&2
  exit 1
fi

for file in "${files[@]}"; do
  echo "applying $(basename "$file")"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -1 -f "$file"
done
echo "all ${#files[@]} migrations applied"
