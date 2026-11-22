// megaui-only (FSL-123: email admission of the Feishu login request; 原参照见 docs/implementation/feishu-login.md「来源」)
/**
 * FSL-123: the only email syntax the Feishu login request admits (ADR-FSL-11 「请求」).
 *
 * The value is trimmed, lowercased as a whole and then checked: at most 254 characters and the
 * existing email syntax of this application. That syntax is the one Better Auth's own email
 * routes and the web forms already use: the default `z.email()` pattern of zod 4
 * (`zod@4.5.4` `v4/core/regexes.js` `email`), copied here so `@megaui/auth` keeps no direct zod
 * dependency. An empty value, a value without `@`, a value over 254 characters and a value with
 * inner whitespace never match.
 */

/** The longest email the request path admits (ADR-FSL-11). */
export const FEISHU_LOGIN_EMAIL_MAX_LENGTH = 254;

// zod@4.5.4 v4/core/regexes.js `email` (the default pattern of `z.email()`), the same language
// with the redundant escapes inside character classes dropped (`\-\.` → `.-`, `\-` → `-`).
const EMAIL_SYNTAX =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+.-]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

/**
 * Returns the trimmed, lowercased email, or `null` when the value is not an admissible email.
 * The length is checked before the pattern so the pattern only ever runs on bounded input.
 */
export function normalizeFeishuLoginEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > FEISHU_LOGIN_EMAIL_MAX_LENGTH) return null;
  return EMAIL_SYNTAX.test(normalized) ? normalized : null;
}
