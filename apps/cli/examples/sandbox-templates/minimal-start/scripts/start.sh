#!/usr/bin/env bash
set -euo pipefail

mkdir -p artifacts
subject="world"

if [[ -n "${OPENPOND_REPLAY_PARAMS_BASE64:-}" ]]; then
  decoded="$(printf '%s' "$OPENPOND_REPLAY_PARAMS_BASE64" | base64 -d 2>/dev/null || true)"
  maybe_subject="$(printf '%s' "$decoded" | sed -n 's/.*"subject"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [[ -n "$maybe_subject" ]]; then
    subject="$maybe_subject"
  fi
fi

printf '{"ok":true,"example":"minimal-start","subject":"%s"}\n' "$subject" > artifacts/start.json
printf 'minimal-start wrote artifacts/start.json for %s\n' "$subject"

