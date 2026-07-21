#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SCENES=(
  Chapter01Policy
  Chapter02Definitions
  Chapter02OnOffPolicy
  Chapter03RLSignals
  Chapter04RLVR
  Chapter05GRPO
  Chapter06Distillation
  Chapter07Methods
  Chapter08Research
)

MANIMGL_BIN="${MANIMGL_BIN:-manimgl}"

for scene in "${SCENES[@]}"; do
  "$MANIMGL_BIN" course.py "$scene" -w -m -q --log-level WARNING
done

ffmpeg \
  -hide_banner \
  -loglevel error \
  -f concat \
  -safe 0 \
  -i playlist.txt \
  -c copy \
  -y \
  videos/PostTrainingFromFirstPrinciples.mp4
