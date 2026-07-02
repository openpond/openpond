#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts volumes/app-state
count="0"
if [[ -f volumes/app-state/ingest-count.txt ]]; then
  count="$(cat volumes/app-state/ingest-count.txt)"
fi
printf '{"ok":true,"action":"snapshot","ingestCount":%s}\n' "$count" > artifacts/snapshot.json
printf 'snapshot wrote artifacts/snapshot.json with ingest count %s\n' "$count"

