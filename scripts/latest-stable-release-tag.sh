#!/usr/bin/env bash

set -euo pipefail

# Git globs are not anchored, so a pattern such as v[0-9]*.[0-9]*.[0-9]*
# also matches prerelease tags. Filter the version-sorted tag list with an
# anchored expression and return only the newest plain vMAJOR.MINOR.PATCH tag.
git tag --sort=-v:refname --list \
  | awk '!found && /^v[0-9]+\.[0-9]+\.[0-9]+$/ { print; found = 1 }'
