#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts volumes/app-state
printf '{"ok":true,"example":"service-with-actions","mode":"smoke"}\n' > artifacts/smoke.json
printf 'service-with-actions smoke wrote artifacts/smoke.json\n'

