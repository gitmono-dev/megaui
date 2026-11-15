# enterprise-auth e2e catalog

> Specification: FS-20 / FS-26
> Tier: enterprise owned Web + isolated PostgreSQL + FSM-05 Mock + Chromium

## Scenarios

| ID | Name | AC |
|---|---|---|
| S-01 | Enterprise sign-in explains private pairing and renders alias/code controls | 1, 2 |
| S-02 | Pairing request stores the secure flow cookie and exposes only the `/login` command token | 3 |
| S-03 | Status polling reaches confirmed without returning OTP/code/token fields | 3, 5 |
| S-04 | Eight-character code verification redirects only to the internal workspace path | 2, 6 |
| S-05 | Signup, forgot-password, and reset-password pages return 404 in enterprise mode | 7, 8 |

Run with:

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-auth.spec.ts --config=playwright.enterprise-auth.config.ts --workers=1 --trace=off
```

The test uses the FS-89 isolated fixture. It never writes a session or OTP directly: the browser requests pairing, the FSM-05 Mock receives the private message through the existing bot-login path, and only the returned synthetic code is entered into the page.
