#!/usr/bin/env bash
# Guard the secret keys of the Feishu email-code login (FSL-141).
#
# The list below is the single source of these secret keys. The production
# surfaces must not assign them, and the sample env files may only carry a
# placeholder for them. A hit and a scan error both fail closed, and the
# failure output names the file, the line and the key, never the value.
#
# The scan is written in Python so that the guard needs no external tool: it
# also runs inside the unit test step, which happens before CI installs
# ripgrep for the residue guard.
set -euo pipefail

SECRET_KEYS=(
  ENTERPRISE_OTP_HMAC_KEY
  FEISHU_APP_SECRET
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${SECRET_KEYS[@]}"
  exit 0
fi

# The scan targets are injectable so that the guard test drives them with
# fixtures instead of the repository files.
surfaces="${MEGAUI_SECRET_KEY_SURFACES:-apps packages scripts package.json pnpm-workspace.yaml}"
samples="${MEGAUI_SECRET_KEY_SAMPLES:-env.example .env.test.example}"

MEGAUI_SECRET_KEY_LIST="${SECRET_KEYS[*]}"
MEGAUI_SECRET_KEY_SURFACES="$surfaces"
MEGAUI_SECRET_KEY_SAMPLES="$samples"
export MEGAUI_SECRET_KEY_LIST MEGAUI_SECRET_KEY_SURFACES MEGAUI_SECRET_KEY_SAMPLES

python3 - <<'PY'
import os
import re
import sys
from pathlib import Path

keys = [key for key in os.environ.get("MEGAUI_SECRET_KEY_LIST", "").split() if key]
surfaces = [name for name in os.environ.get("MEGAUI_SECRET_KEY_SURFACES", "").split() if name]
samples = [name for name in os.environ.get("MEGAUI_SECRET_KEY_SAMPLES", "").split() if name]
PLACEHOLDER = re.compile(r"^(replace-with-|REPLACE_WITH_)")
SAMPLE_ASSIGNMENT = re.compile(
    r"^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$"
)
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
    print("ERROR: the secret key list is empty", file=sys.stderr)
    sys.exit(2)
if not surfaces:
    print("ERROR: no production surface to scan for secret keys", file=sys.stderr)
    sys.exit(2)
if not samples:
    print("ERROR: no sample env file to scan for secret keys", file=sys.stderr)
    sys.exit(2)

# A key only counts when it is assigned on its own: a longer name that ends
# with the same word is a different configuration.
KEY_GROUP = r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(key) for key in keys) + r")"
# Every scanned file: `KEY=` (a shell, env or string assignment).
ASSIGNMENT = re.compile(KEY_GROUP + r"=(?!=)")
# Production files also refuse the other assignment forms: spaced or
# compound with any JavaScript assignment operator (`KEY = value`,
# `process.env.KEY += value`, `process.env.KEY ||= value`), bracketed
# (`process.env["KEY"] = value`) and an object or JSON entry with a string
# literal (`KEY: "value"`, `"KEY": "value"`, `["KEY"]: "value"`). Prose such
# as `KEY`: text in a comment and comparisons (`==`) are not assignments.
# Test files may set these keys to fixture values in those forms (for example
# a stubbed `process.env`), so they are held to the `KEY=` form only.
PRODUCTION_ASSIGNMENT = re.compile(
    KEY_GROUP
    + r"(?:[\"'`]\s*)?(?:\]\s*)?"
    + r"(?:\s*(?:\*\*|<<|>>>?|\|\||&&|\?\?|[-+*/%&|^])?=(?!=)|:\s*[\"'`])"
)
TEST_FILE = re.compile(r"\.(?:test|spec)\.[cm]?[jt]sx?$")
TEST_DIRS = {"tests", "__tests__"}


def is_test_file(path: Path, target: Path) -> bool:
    # Only the part below the scan target counts, so that the location of the
    # checkout itself never turns a production file into a test file.
    relative = path.relative_to(target) if path != target else Path(path.name)
    return bool(TEST_FILE.search(path.name)) or any(part in TEST_DIRS for part in relative.parts[:-1])


def raise_walk_error(error: OSError):
    # os.walk skips a directory it cannot read unless the error is raised.
    raise error


def files_of(target: Path):
    if target.is_file():
        yield target
        return
    if not target.exists():
        raise FileNotFoundError(f"scan target does not exist: {target}")
    if not target.is_dir():
        raise NotADirectoryError(f"scan target is neither a file nor a directory: {target}")
    for directory, subdirectories, names in os.walk(target, onerror=raise_walk_error):
        subdirectories[:] = sorted(name for name in subdirectories if name not in SKIP_DIRS)
        for name in sorted(names):
            entry = Path(directory) / name
            if entry.is_dir():
                # A symbolic link to a directory is not followed.
                continue
            yield entry


hits: list[str] = []
for name in surfaces:
    target = Path(name)
    try:
        candidates = list(files_of(target))
    except OSError as error:
        print(f"ERROR: secret key scan failed: {error}", file=sys.stderr)
        sys.exit(2)
    for candidate in candidates:
        try:
            content = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError as error:
            print(f"ERROR: secret key scan failed: {error}", file=sys.stderr)
            sys.exit(2)
        production = not is_test_file(candidate, target)
        found: dict[int, str] = {}
        for number, line in enumerate(content.splitlines(), 1):
            match = ASSIGNMENT.search(line)
            if match:
                found.setdefault(number, match.group(1))
        if production:
            # Matched against the whole file so that an assignment split across
            # lines (`KEY` then `+= value` on the next line) is still caught;
            # the line where the key starts is reported.
            for match in PRODUCTION_ASSIGNMENT.finditer(content):
                found.setdefault(content.count("\n", 0, match.start()) + 1, match.group(1))
        for number in sorted(found):
            # Only the key is reported, never the value.
            hits.append(f"{candidate}:{number}:{found[number]}=")

if hits:
    print("ERROR: secret keys are assigned in production surfaces:", file=sys.stderr)
    print("\n".join(hits), file=sys.stderr)
    sys.exit(1)

bad: list[str] = []
for name in samples:
    path = Path(name)
    if not path.is_file():
        print(f"ERROR: missing sample env file: {name}", file=sys.stderr)
        sys.exit(2)
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        print(f"ERROR: secret key scan failed: {error}", file=sys.stderr)
        sys.exit(2)
    for index, line in enumerate(content.splitlines(), 1):
        # Leading blanks, `export`, blanks around `=` and quotes do not hide a
        # key, and a commented-out assignment (`# KEY=value`) is checked too: a
        # sample must not carry a real value even where it is disabled.
        match = SAMPLE_ASSIGNMENT.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key in keys and not PLACEHOLDER.match(value):
            # The value is never echoed: a sample file may carry a real secret.
            bad.append(f"{name}:{index}:{key}")

if bad:
    print("Secret keys with a non-placeholder value in sample env files:", file=sys.stderr)
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)

print("check-secret-keys: OK")
PY
