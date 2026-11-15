#!/usr/bin/env bash
# OPS-02 docs relative-link checker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 <<'PY'
from pathlib import Path
import re
import sys

root = Path("docs")
link_re = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
broken = []
checked = 0

for md in root.rglob("*.md"):
    text = md.read_text(encoding="utf-8")
    for match in link_re.finditer(text):
        target = match.group(1).strip()
        if not target or target.startswith(("#", "http://", "https://", "mailto:")):
            continue
        # strip optional title
        path_part = target.split()[0].strip("\"'")
        path_part = path_part.split("#", 1)[0]
        if not path_part:
            continue
        checked += 1
        resolved = (md.parent / path_part).resolve()
        try:
            resolved.relative_to((root.resolve()))
        except ValueError:
            # allow links that escape docs/ into repo root (e.g. ../AGENTS.md)
            pass
        if not resolved.exists():
            broken.append(f"{md}: {path_part}")

if broken:
    print("check-docs-links: broken links:", file=sys.stderr)
    for line in broken:
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)

print(f"check-docs-links: OK ({checked} relative links)")
PY
