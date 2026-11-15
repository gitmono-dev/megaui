#!/usr/bin/env bash
# Guard the enterprise secret keys (ADR-FS-ENT-07).
#
# The list below is the single source of the enterprise secret keys. The
# production surfaces must not assign them, and the sample env files may only
# carry a placeholder for them. A hit and a scan error both fail closed, and
# the failure output names the file, the line and the key, never the value.
#
# The scan is written in Python so that the guard needs no external tool: it
# also runs inside the unit test step, which happens before CI installs
# ripgrep for the residue guard.
set -euo pipefail

SECRET_KEYS=(
  ENTERPRISE_CANARY_SIGNING_PRIVATE_KEY
  ENTERPRISE_COLLAB_REVOKE_KEY
  ENTERPRISE_DELIVERY_KEY
  ENTERPRISE_INTROSPECTION_KEY
  ENTERPRISE_IP_HMAC_MASTER_KEY
  ENTERPRISE_LIVE_RESULTS_PRIVATE_KEY
  ENTERPRISE_OTP_HMAC_KEY
  ENTERPRISE_PROBE_SIGNING_PRIVATE_KEY
  FEISHU_APP_SECRET
  FEISHU_EVENT_ENCRYPT_KEY
  FEISHU_EVENT_VERIFICATION_TOKEN
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${SECRET_KEYS[@]}"
  exit 0
fi

# The scan targets are injectable so that the guard test drives them with
# fixtures instead of the repository files.
surfaces="${MEGAUI_ENTERPRISE_SURFACES:-apps packages scripts package.json pnpm-workspace.yaml}"
samples="${MEGAUI_ENTERPRISE_SAMPLES:-env.example .env.test.example}"

ENTERPRISE_SECRET_KEYS="${SECRET_KEYS[*]}"
MEGAUI_ENTERPRISE_SURFACES="$surfaces"
MEGAUI_ENTERPRISE_SAMPLE_FILES="$samples"
export ENTERPRISE_SECRET_KEYS MEGAUI_ENTERPRISE_SURFACES MEGAUI_ENTERPRISE_SAMPLE_FILES

python3 - <<'PY'
import os
import re
import sys
from pathlib import Path

keys = [key for key in os.environ.get("ENTERPRISE_SECRET_KEYS", "").split() if key]
surfaces = [name for name in os.environ.get("MEGAUI_ENTERPRISE_SURFACES", "").split() if name]
samples = [name for name in os.environ.get("MEGAUI_ENTERPRISE_SAMPLE_FILES", "").split() if name]
PLACEHOLDER = re.compile(r"^(replace-with-|REPLACE_WITH_)")
SKIP_DIRS = {
    ".git",
    ".next",
    ".turbo",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "test-results",
}

if not keys:
    print("ERROR: the enterprise secret key list is empty", file=sys.stderr)
    sys.exit(2)
if not surfaces:
    print("ERROR: no production surface to scan for enterprise secrets", file=sys.stderr)
    sys.exit(2)
if not samples:
    print("ERROR: no sample env file to scan for enterprise secrets", file=sys.stderr)
    sys.exit(2)

# A key only counts when it is assigned on its own: a longer name that ends
# with the same word is a different configuration.
ASSIGNMENT = re.compile(
    r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(key) for key in keys) + r")="
)


def files_of(target: Path):
    if target.is_file():
        yield target
        return
    if not target.exists():
        raise FileNotFoundError(f"scan target does not exist: {target}")
    for entry in sorted(target.rglob("*")):
        if entry.is_dir():
            continue
        if any(part in SKIP_DIRS for part in entry.parts):
            continue
        yield entry


hits: list[str] = []
for name in surfaces:
    target = Path(name)
    try:
        candidates = list(files_of(target))
    except (FileNotFoundError, NotADirectoryError, PermissionError) as error:
        print(f"ERROR: enterprise secret scan failed: {error}", file=sys.stderr)
        sys.exit(2)
    for candidate in candidates:
        try:
            content = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError as error:
            print(f"ERROR: enterprise secret scan failed: {error}", file=sys.stderr)
            sys.exit(2)
        for number, line in enumerate(content.splitlines(), 1):
            match = ASSIGNMENT.search(line)
            if match:
                # Only the key is reported, never the value.
                hits.append(f"{candidate}:{number}:{match.group(1)}=")

if hits:
    print(
        "ERROR: enterprise secret keys are assigned in production surfaces:",
        file=sys.stderr,
    )
    print("\n".join(hits), file=sys.stderr)
    sys.exit(1)

bad: list[str] = []
for name in samples:
    path = Path(name)
    if not path.is_file():
        print(f"ERROR: missing sample env file: {name}", file=sys.stderr)
        sys.exit(2)
    for index, line in enumerate(path.read_text().splitlines(), 1):
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key in keys and not PLACEHOLDER.match(value):
            # The value is never echoed: a sample file may carry a real secret.
            bad.append(f"{name}:{index}:{key}")

if bad:
    print(
        "Enterprise secret keys with a non-placeholder value in sample env files:",
        file=sys.stderr,
    )
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)

print("check-enterprise-secrets: OK")
PY
