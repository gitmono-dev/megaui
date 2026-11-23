const DEFAULT_SITE_NAME = "Mega";

/** The configured MegaUI site name. `MEGA_SITE_NAME` is the one display name. */
export function getSiteName(): string {
  const configured = process.env.MEGA_SITE_NAME?.trim() || process.env.NEXT_PUBLIC_MEGA_SITE_NAME?.trim();
  return configured || DEFAULT_SITE_NAME;
}

/** Replaces the default brand in dictionary copy with the configured site name. */
export function applySiteName(text: string): string {
  const name = getSiteName();
  if (name === DEFAULT_SITE_NAME) return text;
  return text.replaceAll(DEFAULT_SITE_NAME, name);
}
