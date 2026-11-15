# auth-flow e2e catalog

> Specification: WA-02  
> Provenance: megaui:apps/next-app/tests/e2e/@0ff3a9d (new; no upstream equivalent)

## Purpose

End-to-end coverage of the four auth pages (`signin`, `signup`, `forgot-password`, `reset-password`) introduced in WA-02.

---

## Scenarios

| ID | Name | AC |
|----|----- |----|
| S-01 | Sign-in card renders (en + zh-CN) | AC-1 |
| S-02 | Email required / invalid-format validation on the sign-in form | AC-1 |
| S-03 | Bad credentials shows `FormError` alert | AC-1 |
| S-04 | Sign-up card renders | AC-1 |
| S-05 | Missing required fields on sign-up triggers validation | AC-1 |
| S-06 | Full register → login → workspace redirect flow | AC-1 |
| S-07 | Forgot-password card renders with correct metadata title | AC-1, AC-3 |
| S-08 | Valid email on forgot-password shows "Check your email" success | AC-1 |
| S-09 | Reset-password card renders with correct metadata title | AC-1, AC-3 |
| S-10 | Missing `?token` on reset-password shows `FormError` on mount | AC-1 |
| S-11 | Passwords don't match shows field error | AC-1 |
| S-12 | Full reset-password flow with real token | AC-1 |
| S-13 | Signed-in user visiting `/signin` is redirected to `/workspace` | AC-2 |
| S-14 | Signed-in user visiting `/signup` is redirected to `/workspace` | AC-2 |
| S-15 | No social-provider buttons when `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID` unset | AC-4 |

---

## Reset-token minting strategy (S-12)

Run the CI-isolated project with:

```sh
NODE_OPTIONS=--import=tsx pnpm exec tsx apps/web/tests/helpers/owned-web.ts e2e apps/web/tests/e2e/auth-flow.spec.ts
```

The owner creates a run-scoped PostgreSQL database and Web process from an environment-free source
copy, then removes both resources before the command returns. A missing live provider is not a pass.

S-12 calls `mintResetToken()` which:
1. Signs up a fresh `wa02-reset-<uuid>@example.com` user via `auth.api.signUpEmail`.
2. Calls `auth.api.requestPasswordReset` (server-side, bypasses HTTP).
3. Reads the raw token from `verification.value WHERE identifier = email` via drizzle.

The scenario is skipped (not failed) if the DB is unavailable.

---

## Known intentional differences from upstream

- No `resend-verification` dialog (WA-02 scope).
- No username / image fields in sign-up (BFF deferred to WA-03/EG-11).
- No Turnstile/captcha assertions (ADR-ARCH-04 permanent non-goal).
- No wechat / phone sign-in tests.

The legacy spec remains the email/password compatibility flow. Enterprise mode uses the separate
`enterprise-auth.spec.ts` contract and hides signup/recovery pages; it does not weaken the legacy
validation or redirect scenarios above.
