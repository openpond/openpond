#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
output_dir="$repo_root/dist/turnkey-agent"
export PKG_CACHE_PATH="${PKG_CACHE_PATH:-$HOME/.pkg-cache}"
runtime="$PKG_CACHE_PATH/v3.6/fetched-v24.20.0-linuxstatic-x64"
runtime_sha256="83223146550e6dce2e773e1668b397aab63664e820ac40551f9df16b0d8b276f"
# Pin and verify the upstream prebuilt runtime before pkg executes or embeds it.
if [[ ! -f "$runtime" ]]; then
  mkdir -p "$(dirname "$runtime")"
  download="$(mktemp "${runtime}.download.XXXXXX")"
  trap 'rm -f "$download"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 \
    https://github.com/yao-pkg/pkg-fetch/releases/download/v3.6/node-v24.20.0-linuxstatic-x64 -o "$download"
  printf '%s  %s\n' "$runtime_sha256" "$download" | sha256sum --check --status
  chmod 755 "$download"
  mv "$download" "$runtime"
  trap - EXIT
fi
printf '%s  %s\n' "$runtime_sha256" "$runtime" | sha256sum --check --status
pnpm exec tsx scripts/build/bundle-tvc.ts
pnpm --package=@yao-pkg/pkg@6.23.0 dlx --shell-mode \
  'node examples/turnkey-agent/packaging/package-runtime.cjs "$(command -v pkg)"'
file "$output_dir/openpond-tvc"
readelf -h "$output_dir/openpond-tvc" | grep -q 'Advanced Micro Devices X86-64'
if readelf -l "$output_dir/openpond-tvc" | grep -q INTERP; then
  echo 'The executable still needs a dynamic loader' >&2; exit 1
fi
if readelf -d "$output_dir/openpond-tvc" | grep -q NEEDED; then
  echo 'The executable still needs shared libraries' >&2; exit 1
fi
sha256sum "$output_dir/openpond-tvc" > "$output_dir/executable.sha256"
node examples/turnkey-agent/check.mjs "$output_dir/openpond-tvc"
echo 'Static executable checked. Publish its OCI image and pin the linux/amd64 image digest before deploying.'
