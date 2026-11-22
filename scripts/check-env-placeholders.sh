#!/usr/bin/env bash
# Validate that sensitive keys in sample env files use placeholder prefixes
# (replace-with-* / REPLACE_WITH_*), not real-looking credentials. The secret
# keys of the Feishu login (FEISHU_APP_SECRET, ENTERPRISE_OTP_HMAC_KEY) are
# listed once, in scripts/check-secret-keys.sh, and checked there.
set -euo pipefail

python3 - "$@" <<'PY'
import re
import sys
from pathlib import Path

SENSITIVE = {
    "BETTER_AUTH_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_SECRET",
    "SMTP_PASS",
    "SMTP_USER",
    "RESEND_API_KEY",
    "MEGA2_INTERNAL_MAIL_BEARER",
    "MEGA_COLLAB_INTERNAL_TOKEN",
    "S3_ACCESS_KEY_ID",
    "S3_ACCESS_KEY_SECRET",
    "AI_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GITHUB_CLIENT_ID",
}
PLACEHOLDER = re.compile(r"^(replace-with-|REPLACE_WITH_)")

paths = [Path(p) for p in (sys.argv[1:] or ["env.example", ".env.test.example"])]
bad: list[str] = []
for path in paths:
    if not path.is_file():
        print(f"ERROR: missing sample env file: {path}", file=sys.stderr)
        sys.exit(2)
    for i, line in enumerate(path.read_text().splitlines(), 1):
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        if key in SENSITIVE and not PLACEHOLDER.match(val):
            # The value is never echoed: a sample file may carry a real secret.
            bad.append(f"{path}:{i}:{key}")

if bad:
    print("Non-placeholder sensitive values in sample env files:", file=sys.stderr)
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)

print("check-env-placeholders: OK")
PY
