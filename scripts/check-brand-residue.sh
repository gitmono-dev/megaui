#!/usr/bin/env bash
# OPS-02 brand residue guard (two zero-hit segments).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "check-brand-residue: $*" >&2; exit 1; }

# Avoid embedding searchable brand literals as contiguous tokens in this file's
# "content under test" by building them at runtime.
TINYSHIP="$(printf '%s%s' 'tiny' 'ship')"
LEGACY_UI="$(printf '%s%s' 'mono' 'ui')"

RG_GLOBS=(
  --glob '!env.example'
  --glob '!.env.test.example'
  --glob '!node_modules/**'
  --glob '!.next/**'
  --glob '!.turbo/**'
  --glob '!dist/**'
  --glob '!pnpm-lock.yaml'
  --glob '!**/*.png'
  --glob '!**/*.ico'
  --glob '!**/*.svg'
  --glob '!scripts/check-brand-residue.sh'
  --glob '!**/*brand-residue*'
  --glob '!**/*provenance.test.ts'
)

# --- segment 1: legacy demo-brand zero hits ---
set +e
rg -i "$TINYSHIP" "${RG_GLOBS[@]}" .
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  fail "${TINYSHIP} hits found"
elif [[ $rc -ne 1 ]]; then
  fail "rg ${TINYSHIP} failed with exit $rc"
fi

# --- segment 2: upstream-frontend token zero hits ---
set +e
rg -i "$LEGACY_UI" "${RG_GLOBS[@]}" .
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  fail "${LEGACY_UI} hits found"
elif [[ $rc -ne 1 ]]; then
  fail "rg ${LEGACY_UI} failed with exit $rc"
fi

echo "check-brand-residue: OK"
