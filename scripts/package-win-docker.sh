#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="/dev/shm/openpond-builder"
IMAGE="electronuserland/builder:wine"

/bin/rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/builder-tmp/home \
  -e ELECTRON_BUILDER_CACHE=/builder-tmp/cache \
  -v "$(dirname "$ROOT_DIR")":"$(dirname "$ROOT_DIR")" \
  -v "$WORK_DIR":/builder-tmp \
  -w "$ROOT_DIR" \
  "$IMAGE" \
  bash -lc 'mkdir -p "$HOME" "$ELECTRON_BUILDER_CACHE" && node_modules/.bin/electron-builder --config apps/desktop/electron-builder.json --win nsis -c.directories.output=/builder-tmp/release'

mkdir -p "$ROOT_DIR/release"
cp "$WORK_DIR/release/OpenPond App Setup 0.1.0.exe" "$ROOT_DIR/release/"
cp "$WORK_DIR/release/OpenPond App Setup 0.1.0.exe.blockmap" "$ROOT_DIR/release/"
cp "$WORK_DIR/release/latest.yml" "$ROOT_DIR/release/latest-win.yml"

sha256sum "$ROOT_DIR/release/OpenPond App Setup 0.1.0.exe"
