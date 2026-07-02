#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts volumes/app-state
count_file="volumes/app-state/ingest-count.txt"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
count="$((count + 1))"
printf '%s\n' "$count" > "$count_file"
printf '{"ok":true,"action":"ingest","count":%s}\n' "$count" > artifacts/ingest.json
printf 'ingest wrote artifacts/ingest.json with count %s\n' "$count"

