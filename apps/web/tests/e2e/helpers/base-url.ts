/** Shared Playwright base URL for local (:3000) vs compose live (:17001). */
export function e2eBaseURL(): string {
  const raw = process.env.E2E_BASE_URL?.trim();
  if (raw && raw.length > 0) return raw.replace(/\/$/, "");
  return "http://127.0.0.1:3000";
}
