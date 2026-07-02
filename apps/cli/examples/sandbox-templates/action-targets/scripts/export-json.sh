#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts
printf '{"ok":true,"action":"export-json"}\n' > artifacts/export.json
printf 'export-json wrote artifacts/export.json\n'

