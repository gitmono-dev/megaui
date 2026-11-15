#!/usr/bin/env bash
# megaui-only (FIX-FS-01): fixed-source CI prerequisite.
set -euo pipefail

readonly ci_rg_url='https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz'
readonly ci_rg_digest='1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599'
readonly ci_rg_member='ripgrep-15.1.0-x86_64-unknown-linux-musl/rg'

if [ "$(uname -s):$(uname -m)" != 'Linux:x86_64' ]; then
  echo 'CI ripgrep requires Linux x86_64' >&2
  exit 1
fi
if [ -z "${RUNNER_TEMP:-}" ] || [ -z "${GITHUB_PATH:-}" ] ||
   [ ! -d "$RUNNER_TEMP" ] || [ ! -w "$RUNNER_TEMP" ] ||
   [ ! -f "$GITHUB_PATH" ] || [ ! -w "$GITHUB_PATH" ]; then
  echo 'CI ripgrep requires writable job temporary and PATH files' >&2
  exit 1
fi
case "$RUNNER_TEMP$GITHUB_PATH" in
  *$'\n'*|*$'\r'*) echo 'CI ripgrep rejects multiline job paths' >&2; exit 1 ;;
esac

ci_rg_download=''
ci_rg_tools=''
ci_rg_published=0
cleanup() {
  local ci_rg_status=$?
  trap - EXIT
  if [ -n "$ci_rg_download" ]; then rm -rf -- "$ci_rg_download" || ci_rg_status=1; fi
  if [ "$ci_rg_published" -eq 0 ] && [ -n "$ci_rg_tools" ]; then
    rm -rf -- "$ci_rg_tools" || ci_rg_status=1
  fi
  exit "$ci_rg_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ci_rg_download=$(mktemp -d "$RUNNER_TEMP/megaui-ripgrep-download.XXXXXXXX")
# -q must be first: default curl configuration must not add URLs or retries.
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --tlsv1.2 --connect-timeout 10 --max-time 45 \
  --output "$ci_rg_download/archive.tar.gz" "$ci_rg_url"
printf '%s  %s\n' "$ci_rg_digest" "$ci_rg_download/archive.tar.gz" | sha256sum --check --status
mkdir "$ci_rg_download/extracted"
tar -xzf "$ci_rg_download/archive.tar.gz" -C "$ci_rg_download/extracted" \
  --strip-components=1 "$ci_rg_member"
ci_rg_tools=$(mktemp -d "$RUNNER_TEMP/megaui-ripgrep-bin.XXXXXXXX")
install -m 755 "$ci_rg_download/extracted/rg" "$ci_rg_tools/rg"
ci_rg_version_output=$("$ci_rg_tools/rg" --version)
read -r ci_rg_name ci_rg_version ci_rg_revision <<< "$ci_rg_version_output"
if [ "$ci_rg_name" != 'ripgrep' ] || [ "$ci_rg_version" != '15.1.0' ]; then
  echo 'CI ripgrep version verification failed' >&2
  exit 1
fi
printf '%s\n' "$ci_rg_tools" >> "$GITHUB_PATH"
ci_rg_published=1
echo 'Installed ripgrep 15.1.0 (verified SHA-256)'
