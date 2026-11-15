# E2E catalog — home (WA-01)

| Spec | Coverage |
|---|---|
| `apps/web/tests/e2e/home.spec.ts` | `/` → `/{lang}` locale negotiation (cookie → Accept-Language → default); guest homepage Login CTA (en + zh-CN); signed-in homepage Enter Workspace CTA (session minted via `@megaui/auth` server API + cookie jar); fail-closed page redirect to signin; fail-closed API 401; `/api/health` DB status without connection-string leak |

## Notes

- Auth page bodies themselves land in WA-02; WA-01 only asserts redirect Location / status for protected routes.
- Session mint helper: `apps/web/tests/e2e/helpers/session.ts` (does not require `/api/auth` route).
