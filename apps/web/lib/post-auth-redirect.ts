/**
 * Resolve a safe same-app post-auth path from auth-page query params.
 *
 * Fail-closed middleware redirects guests with `callbackUrl`; forms also accept
 * legacy `returnTo`. External or protocol-relative targets fall back to default.
 */
export function resolvePostAuthPath(
  searchParams: URLSearchParams,
  locale: string,
  fallback = `/${locale}/workspace`,
): string {
  const raw =
    searchParams.get("callbackUrl") ?? searchParams.get("returnTo");
  if (!raw) return fallback;
  return sanitizeRelativeAppPath(raw, fallback);
}

function sanitizeRelativeAppPath(path: string, fallback: string): string {
  const trimmed = path.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    trimmed.includes(":")
  ) {
    return fallback;
  }
  return trimmed;
}
