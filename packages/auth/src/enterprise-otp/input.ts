// megaui-only (FS-49): bounded ASCII OTP input and strict login-name parsing.
import { isCanonicalEnterpriseOtpCode } from "./code";

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

export function normalizeEnterpriseOtpInput(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return null;
  }
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isAsciiWhitespace(value.charCodeAt(end - 1))) end--;
  // The entire original input is ASCII, so uppercasing cannot fold Unicode.
  const normalized = value.slice(start, end).toUpperCase();
  return isCanonicalEnterpriseOtpCode(normalized) ? normalized : null;
}

export function parseEnterpriseLoginName(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 64) return null;
  // A negated character class also rejects a final newline, unlike a lone $ anchor.
  if (!/^[a-z0-9]/.test(value) || /[^a-z0-9._-]/.test(value)) return null;
  return value;
}
