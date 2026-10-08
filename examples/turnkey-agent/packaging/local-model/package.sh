#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$root"
cache="$root/tmp/tvc-inference"
mkdir -p "$cache"
model="${1:-$cache/SmolLM2-135M-Instruct-Q4_K_M.gguf}"
if [ ! -f "$model" ]; then
  download="$(mktemp "$cache/model.XXXXXX")"
  trap 'rm -f "$download"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 \
    'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/09816acd5d99df7be770d85ea30822623dab342c/SmolLM2-135M-Instruct-Q4_K_M.gguf' -o "$download"
  printf '%s  %s\n' 2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d "$download" | sha256sum --check --status
  mv "$download" "$model"
  trap - EXIT
fi
bash examples/turnkey-agent/packaging/local-model/build-runtime.sh
TVC_MAX_OLD_SPACE_MB=128 pnpm tvc:package
python3 examples/turnkey-agent/packaging/local-model/append-model.py \
  --app dist/turnkey-agent/openpond-tvc \
  --engine dist/turnkey-agent-local-model/llama-server --model "$model" \
  --output dist/turnkey-agent-local-model/openpond-runtime
cc -Os -static -Wall -Wextra -Werror examples/turnkey-agent/packaging/local-model/launcher.c -llzma \
  -o dist/turnkey-agent-local-model/launcher
strip dist/turnkey-agent-local-model/launcher
python3 examples/turnkey-agent/packaging/local-model/wrap.py \
  --launcher dist/turnkey-agent-local-model/launcher \
  --runtime dist/turnkey-agent-local-model/openpond-runtime \
  --output dist/turnkey-agent-local-model/openpond-tvc
