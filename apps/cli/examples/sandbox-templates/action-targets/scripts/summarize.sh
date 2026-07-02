#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts
printf 'summarize action ran\n' > artifacts/summary.txt
printf 'summarize wrote artifacts/summary.txt\n'

