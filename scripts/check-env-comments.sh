#!/usr/bin/env bash
# Exits 0 iff every `KEY=` line in the target env file has a `#` comment
# line directly above it (blank lines in between are allowed, as long as
# the nearest non-blank line above is a comment).
#
# Usage: scripts/check-env-comments.sh [path-to-env-file]
set -euo pipefail

file="${1:-env.example}"

if [[ ! -f "$file" ]]; then
  echo "check-env-comments: file not found: $file" >&2
  exit 1
fi

status=0
prev_non_blank=""

while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip blank (or whitespace-only) lines without updating prev_non_blank.
  if [[ -z "${line//[[:space:]]/}" ]]; then
    continue
  fi

  if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    if [[ "$prev_non_blank" != \#* ]]; then
      key="${line%%=*}"
      echo "check-env-comments: missing '#' comment above ${key}=" >&2
      status=1
    fi
  fi

  prev_non_blank="$line"
done <"$file"

if [[ "$status" -eq 0 ]]; then
  echo "check-env-comments: OK ($file)"
fi

exit "$status"
