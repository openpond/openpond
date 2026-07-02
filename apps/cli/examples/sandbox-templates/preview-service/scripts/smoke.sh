#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts
printf '{"ok":true,"example":"preview-service","mode":"smoke"}\n' > artifacts/smoke.json
printf 'preview-service smoke wrote artifacts/smoke.json\n'

