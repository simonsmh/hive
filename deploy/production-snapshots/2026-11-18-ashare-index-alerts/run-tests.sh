#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
vitest="$repo/packages/core/node_modules/.bin/vitest"
if [[ ! -x "$vitest" ]]; then
  echo "Install workspace deps first (pnpm install). Missing $vitest" >&2
  exit 1
fi
cd "$repo/packages/core"
exec "$vitest" run --config "$here/vitest.config.cjs" --root "$here"
