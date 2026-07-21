#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SCENES=(
  Appendix01GRPODetails
  Appendix02DistillationSystems
  Appendix03MethodStudies
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
  -i appendix_playlist.txt \
  -c copy \
  -y \
  videos/PostTrainingAdvancedAppendix.mp4
