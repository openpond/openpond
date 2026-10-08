#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$root"
revision=5ad1c5da0ad7f6176256b823925aad19134f0263
archive_sha=716ad5d9c20d3a3a0af64bfac5d7c6a64c5c47287e9be5e917de51a1a3722768
cache="$root/tmp/tvc-inference"
mkdir -p "$cache"
archive="$cache/llama-source.tar.gz"
if [ ! -f "$archive" ]; then
  curl --fail --location --retry 2 "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/$revision" --output "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --status
source_dir="$cache/llama.cpp-$revision"
patch_file="$root/examples/turnkey-agent/packaging/local-model/embedded-gguf.patch"
patch_sha="$(sha256sum "$patch_file" | cut -d ' ' -f 1)"
if [ ! -f "$source_dir/.openpond-patch" ] || [ "$(cat "$source_dir/.openpond-patch")" != "$patch_sha" ]; then
  tar -xzf "$archive" -C "$cache"
  patch -d "$source_dir" -p1 < "$patch_file"
  printf '%s\n' "$patch_sha" > "$source_dir/.openpond-patch"
fi
cmake -S "$source_dir" -B "$cache/build" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_STATIC=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DGGML_BACKEND_DL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_UI=OFF \
  -DCMAKE_EXE_LINKER_FLAGS=-static
cmake --build "$cache/build" --target llama-server -j "${TVC_BUILD_JOBS:-4}"
mkdir -p dist/turnkey-agent-local-model
cp "$cache/build/bin/llama-server" dist/turnkey-agent-local-model/llama-server
strip dist/turnkey-agent-local-model/llama-server
if readelf -l dist/turnkey-agent-local-model/llama-server | grep -q INTERP || readelf -d dist/turnkey-agent-local-model/llama-server | grep -q NEEDED; then
  echo 'Inference runtime is not fully static' >&2
  exit 1
fi
sha256sum dist/turnkey-agent-local-model/llama-server
