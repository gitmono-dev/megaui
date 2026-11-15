#!/usr/bin/env bash
# OPS-02 license allowlist guard.
# Permissive core set from the plan AC, plus normalized aliases and a small
# explicit exception list for unavoidable transitive tooling fonts/parsers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

pnpm licenses list --json >"$tmp"

python3 - "$tmp" <<'PY'
import json, re, sys
from pathlib import Path

allowed = {
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    # Common aliases / public-domain-equivalent used by the lockfile
    "MIT-0",
    "Unlicense",
    "BlueOak-1.0.0",
    "CC0-1.0",
}

aliases = {
    "apache-2.0": "Apache-2.0",
    "Apache 2.0": "Apache-2.0",
    "BSD": "BSD-3-Clause",
}

# Unavoidable transitive / font packages (document in OPS-02 review P2).
exceptions = {
    "geist": "SIL OPEN FONT LICENSE",
    "caniuse-lite": "CC-BY-4.0",
    "lightningcss": "MPL-2.0",
    "lightningcss-linux-arm64-gnu": "MPL-2.0",
    "lightningcss-linux-x64-gnu": "MPL-2.0",
    "lightningcss-darwin-arm64": "MPL-2.0",
    "lightningcss-darwin-x64": "MPL-2.0",
    "lightningcss-win32-x64-msvc": "MPL-2.0",
    "@img/sharp-libvips-linux-arm64": "LGPL-3.0-or-later",
    "@img/sharp-libvips-linuxmusl-arm64": "LGPL-3.0-or-later",
    "@img/sharp-libvips-linux-x64": "LGPL-3.0-or-later",
    "@img/sharp-libvips-linuxmusl-x64": "LGPL-3.0-or-later",
    "@img/sharp-libvips-darwin-arm64": "LGPL-3.0-or-later",
    "khroma": "Unknown",
}

data = json.loads(Path(sys.argv[1]).read_text())
pairs = []
for license_name, packages in data.items():
    for pkg in packages:
        pairs.append((pkg.get("name"), license_name))

bad = []
for name, lic in pairs:
    text = str(lic)
    if name in exceptions:
        continue
    normalized = aliases.get(text, text)
    tokens = re.findall(r"[A-Za-z0-9.+-]+", normalized)
    if normalized in allowed or any(t in allowed for t in tokens):
        continue
    bad.append(f"{name}: {text}")

if bad:
    print("check-licenses: disallowed licenses:", file=sys.stderr)
    for line in bad[:80]:
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)

print(f"check-licenses: OK ({len(pairs)} packages; {len(exceptions)} named exceptions)")
PY
