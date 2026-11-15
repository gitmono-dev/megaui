# `@megaui/auth`

better-auth server configuration and React client for megaui
(`ADR-ARCH-04`): drizzle (PG) adapter, email/password with verification /
reset hooks via `@megaui/email`, optional Google/GitHub OAuth (default
off), and trusted-origin resolution for local + mega2 IT stacks.

## Provenance (GC-03)

Ported surfaces carry a GC-03 provenance header such as
`megaui:libs/auth/auth.ts@0ff3a9d`. Baseline SHA `0ff3a9d` (plan `REF-07`).

| File | Source path |
|---|---|
| `src/create-auth.ts` | `libs/auth/auth.ts` |
| `src/auth-client.ts` | `libs/auth/authClient.ts` |
| `src/trusted-origins.ts` | `libs/auth/trusted-origins.ts` |
| `src/referer-info.ts` | `libs/auth/auth.ts` (`getRefererInfo` slice) |
| `src/social-providers.ts` | `libs/auth/auth.ts` (`socialProviders` slice) |
| `src/user-image-url.ts` | `libs/validators/user-image-url.ts` |

### Diffs vs upstream (intentional — registered on the PK-06 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| wechat plugin / phoneNumber plugin / captcha | Removed | SaaS strip + ADR-ARCH-04 |
| Upstream phone temp-email domains | N/A | phone sign-up removed |
| Vue auth client + `genericOAuthClient` / `phoneNumberClient` | Removed | DEBT-05 single-end; no phone/wechat |
| `@config` singleton | Replaced with `CreateAuthConfig` | GC-07 fail-closed explicit deps |
| Always-on Google/GitHub `socialProviders` | Opt-in via credentials | PK-06 AC: default off |
| `validation-better-auth` adapter | Omitted | no `@megaui/validators` yet (WA-02) |
| `appName` brand default | Required `appName` on config | brand strip |
| Root barrel exports React client | Split: server `@megaui/auth`, client `@megaui/auth/client` | Avoid pulling `pg` into browser bundles |
| Image URL validator `@config.storage` | `allowedImagePublicUrlBase` option | explicit DI; keeps `data:`/`javascript:` rejected |

## Usage

Server (Node / route handlers):

```ts
import {
  createAuth,
  resolveSocialProvidersFromEnv,
  toNextJsHandler,
} from "@megaui/auth";
import { getDb } from "@megaui/database";
import { createEmailSender } from "@megaui/email";

const email = createEmailSender({
  defaultFrom: process.env.EMAIL_DEFAULT_FROM!,
  provider: { kind: "test" }, // or smtp / resend
});

export const auth = createAuth({
  appName: "megaui",
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  db: getDb(),
  email,
  requireEmailVerification: false,
  socialProviders: resolveSocialProvidersFromEnv(),
  allowedImagePublicUrlBase: process.env.S3_PUBLIC_URL,
  trustedOrigins: {
    appBaseUrl: process.env.APP_BASE_URL,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    trustedOriginsCsv: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  },
});

export const { GET, POST } = toNextJsHandler(auth);
```

Browser / client components — import the client subpath only:

```ts
import { createAuthClient } from "@megaui/auth/client";

export const authClient = createAuthClient();
```

Auth pages / `/api/auth` wiring are out of scope (WA-02).

## Local smoke (not a CI gate)

With a reachable Postgres (see `@megaui/database` README):

```bash
DATABASE_URL=postgres://megaui:megaui@localhost:5432/website \
  pnpm --filter @megaui/auth smoke:login
```

Prints a sanitized JSON summary (email redacted; no passwords).
