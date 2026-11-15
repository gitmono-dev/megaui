#!/usr/bin/env bash
# OPS-02: every metadata/manifest asset path must exist under apps/web/public/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$ROOT/apps/web/public"
MANIFEST="$PUBLIC/site.webmanifest"

required=(
  favicon.ico
  favicon-16x16.png
  favicon-32x32.png
  apple-touch-icon.png
  android-chrome-192x192.png
  android-chrome-512x512.png
  logo.svg
  site.webmanifest
)

missing=0
for rel in "${required[@]}"; do
  if [[ ! -f "$PUBLIC/$rel" ]]; then
    echo "missing: apps/web/public/$rel" >&2
    missing=1
  fi
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "missing manifest" >&2
  exit 1
fi

while IFS= read -r src; do
  [[ -z "$src" ]] && continue
  rel="${src#/}"
  if [[ ! -f "$PUBLIC/$rel" ]]; then
    echo "manifest src missing: $src" >&2
    missing=1
  fi
done < <(python3 -c 'import json,sys; from pathlib import Path; data=json.loads(Path(sys.argv[1]).read_text());
[print(i["src"]) for i in data.get("icons",[]) if i.get("src")]' "$MANIFEST")

if [[ $missing -ne 0 ]]; then
  exit 1
fi
echo "check-public-assets: OK"
