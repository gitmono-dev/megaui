# `@megaui/i18n`

Bilingual (`en` + `zh-CN`) translation dictionaries for the Mega workspace
product (DIR-04 / PK-03). Zero-dependency, framework-agnostic: plain
TypeScript objects plus a handful of pure helper functions.

```ts
import { getTranslation, resolveApiLocale, isValidLocale } from '@megaui/i18n'

const t = getTranslation('zh-CN')
t.auth.signin.submit // "登录"

// In a BFF route handler:
const locale = resolveApiLocale(request) // reads Accept-Language, falls back to 'en'
```

## Provenance

Every ported file carries a `upstream-frontend:<path>@<sha>` header comment (GC-03).
Source: `upstream-frontend` @ `0ff3a9d`.

| File | Source |
|---|---|
| `src/locales/types.ts` | `libs/i18n/locales/types.ts` |
| `src/locales/en.ts` | `libs/i18n/locales/en.ts` |
| `src/locales/zh-CN.ts` | `libs/i18n/locales/zh-CN.ts` |
| `src/get-translation.ts` | `libs/i18n/index.ts` (`defaultLocale`/`locales`/`localeLabels`/`translations`/`getTranslation`/`isValidLocale` slice) |
| `src/resolve-api-locale.ts` | `libs/i18n/resolve-api-locale.ts` |

`libs/i18n/storage-errors.ts` (upload/user-image error-message formatters)
was **not** ported as part of this card — it is a thin consumer of
`validators.userImage` / an upload-errors namespace and belongs with the
package that owns those call sites (`@megaui/storage`, PK-08) rather than
the dictionary package itself.

Per GC-03, **`upstream-frontend` only ever appears in this exact `upstream-frontend:<path>@<sha>`
provenance form** (file headers here, this README). It never appears inside
a translation value. `legacy-demo-brand` (the upstream-frontend demo/marketing brand) has zero
occurrences anywhere in this package, including comments — see "Brand
residue guard" below.

## Kept namespaces

Key names are kept where retained from upstream-frontend; every value is rewritten to
brand-neutral copy for Mega (ADR-ARCH-07 品牌剥离, DEBT-07).

| Namespace | Covers |
|---|---|
| `common` | Site name, generic actions (login/logout/profile/settings), theme toggle labels |
| `actions` | Generic verb button labels (save/cancel/confirm/delete/edit/…) |
| `email` | `verification` + `resetPassword` transactional email copy (consumed by `@megaui/email`, PK-07) |
| `auth` | Sign in / sign up / forgot password / reset password pages + `authErrors` (Better Auth error-code → message map) |
| `workspace` | The core product surface: nav, command palette, home dashboard, code browser, tags/releases, agent sessions, Agent chat, channel chat, settings (profile/security/SSH keys/tokens/notifications/appearance/shortcuts), inbox, docs (list/detail/edit), Change Lists (list/detail), issues (list/detail) |
| `validators` | Form validation messages (`user.*` field rules, `userImage.*` upload-URL rules) |
| `countries` | Generic country/region display names |
| `header` | App header: auth links, user menu, language switcher, mobile menu labels |
| `upload` | Upload widget copy + `apiErrors` (upload API error-code → message map) |
| `errors` | Cross-cutting domain-error message map, keyed by feature then error code. Currently just `search.cjkScaleExceeded` (EG-14, ADR-FS-01): the user-facing message for `SearchCjkScaleExceededError` / HTTP `SEARCH_CJK_SCALE_EXCEEDED` (`@megaui/engine`'s `errors.ts`, WA-05's 503 envelope `messageKey`) — not ported from upstream-frontend, this key has no upstream source. |

## Removed namespaces (GC-03 differences)

The upstream dictionary carries **44 `legacy-demo-brand`-branded strings per
locale** (2026-09-02 tally, see the PK-03 task card's "Current evidence").
Beyond the brand rewrite, the following **entire top-level namespaces**
were deleted because they belong to upstream-frontend's permanently-out-of-scope SaaS
template domain (payment / subscription / pricing / credits / affiliate /
withdrawal / admin backend / blog CMS / marketing landing pages / AI
image·video generation — see the plan's "SaaS 模板域" line):

| Namespace | Why removed |
|---|---|
| `admin` | SaaS admin backend (users/subscriptions/orders/credits/pricing/blog/commissions/withdrawals management). No admin backend exists in this product. |
| `pricing` | Pricing-plan page copy. No pricing/subscription model in this product. |
| `payment` | Payment success/cancel page copy. No payment provider in this product. |
| `subscription` | "My Subscription" account page copy. No billing in this product. |
| `premiumFeatures` | Subscription-gated feature showcase / demo page. |
| `ai` | Standalone AI chat/image/video **demo playground** page (multi-provider picker, credits-gated). The real in-product AI assistant is `workspace.agent` / `workspace.chat`, which is kept. |
| `home` (SaaS marketing) | Full SaaS marketing landing page (hero/testimonials/pricing CTA/stats/"Buy Now ¥299") was removed. `WA-01` reintroduced a minimal megaui-only `home.{login,enterWorkspace,metadata.*}` namespace for ADR-ARCH-09 (not a port of the SaaS keys). |
| `docs` | Fumadocs-based marketing docs/blog microsite. Not part of this product. |
| `blog` | Blog CMS page copy (list/post/metadata). |
| `dashboard` | Personal-account dashboard built around subscription status, credit balance, and the affiliate program. The non-SaaS parts (profile, account, linked accounts) are already covered by `workspace.settings.{profile,accountSecurity}`, so nothing of value is lost. |
| `navigation` | Top-level marketing/shipping-domain nav (`orders`/`shipments`/`tracking` — upstream-frontend's shipping-SaaS demo domain — plus an `admin` sub-tree). Superseded entirely by `workspace.nav` for the in-app nav and `header` for the site header. |

Additionally, these **sub-keys inside otherwise-kept namespaces** were
dropped (out of scope per the plan's permanent-non-goals list: phone/WeChat
login, Turnstile captcha, multi-vendor object storage):

| Location | Removed keys | Why |
|---|---|---|
| `common` | `viewPlans`, `theme.themes.*` | Pricing-plan CTA; theme preset SKU names belong to `@megaui/ui` tokens (UI-01), not the dictionary. |
| `actions` | `backToList`, `createUser`, `deleteUser`, `createPost`, `deletePost`, `backToBlog` | Admin-backend / blog-CMS specific. |
| `auth.metadata` | `phone`, `wechat` | Phone/WeChat login pages are an explicit non-goal (only signin/signup/forgotPassword/resetPassword are targeted). |
| `auth` | `phone`, `wechat` (whole sub-objects) | Same as above. |
| `auth.signin.socialProviders` | `wechat`, `phone` | Same as above. |
| `auth.signin.errors`, `auth.signup.errors`, `auth.forgetPassword.errors` | `captchaRequired`, `captchaError`, `captchaExpired` | Turnstile captcha is a permanent non-goal. |
| `auth.authErrors` | `PHONE_NUMBER_ALREADY_EXISTS`, `INVALID_PHONE_NUMBER`, `OTP_EXPIRED`, `INVALID_OTP`, `OTP_TOO_MANY_ATTEMPTS`, `CAPTCHA_REQUIRED`, `CAPTCHA_INVALID`, `SMS_SEND_FAILED` | Phone/OTP/SMS auth and captcha are permanent non-goals. |
| `workspace.agent` | `insufficientCredits` | Credit-based billing gate on the Agent; this product has no credits system. |
| `validators` | `blog.*`, `withdrawal.*` | Blog-CMS and payout-specific validation messages. |
| `upload.providers` | `oss`, `cos` | Aliyun OSS / Tencent COS are vendor-specific SDKs; `@megaui/storage` (PK-08) implements the S3-compatible protocol only (`s3`/`r2` kept). |
| `header.navigation`, `header.demos` | entire sub-trees | SaaS demo-showcase nav (AI/premium/pricing/upload demo links, blog, affiliate). |
| `header.userMenu` | `adminPanel` | No admin backend in this product. |

`Mega` (this product's own name, used pervasively inside the ported
`workspace` namespace — e.g. "Mega Agent", "Mega Docs", "Mega API") is
**not** a stripped brand and is used throughout as the brand-neutral
product name.

## Types

- `Locale` (`src/locales/types.ts`) — loose `Record<string, unknown>` shape
  for a locale dictionary module.
- `SupportedLocale` (`src/get-translation.ts`) — `'en' | 'zh-CN'`, derived
  from the `locales` tuple.
- `Translations` (`src/get-translation.ts`) — the canonical dictionary
  shape, inferred from `en` (`typeof en`, via `satisfies Locale` so the
  literal key/value types are preserved instead of widening to
  `Record<string, unknown>`).

## Helpers

- `getTranslation(locale: SupportedLocale): Translations` — returns the
  full dictionary for a locale.
- `isValidLocale(locale: string): locale is SupportedLocale` — type guard.
- `getLocaleLabel(locale: string): string` — human-readable label
  (`'English'` / `'中文'`), falls back to the raw code.
- `resolveApiLocaleFromAcceptLanguage(header: string | null | undefined): SupportedLocale`
  — pure `Accept-Language` header parser (exact match → `zh-*` prefix
  match → `defaultLocale` fallback).
- `resolveApiLocale(request: ApiLocaleRequestLike): SupportedLocale` — thin
  wrapper reading `request.headers.get('accept-language')`.
  `ApiLocaleRequestLike` is a **structural** interface (`{ headers: { get(name): string | null } }`)
  rather than the DOM `Request` type, so this package works in any runtime
  (Node/edge/workers) without adding the `DOM` lib to its `tsconfig.json`,
  while still being satisfied by a real fetch `Request`.

## Tests

- `src/locales/parity.test.ts` — recursively diffs every leaf key path
  between `en` and `zh-CN`; fails if either locale has a key the other is
  missing (PK-03 AC 1).
- `src/locales/brand-residue.test.ts` — recursively collects every string
  *value* in both dictionaries and asserts zero matches for
  `/legacy-demo-brand|upstream-frontend/i` (PK-03 AC 2). This checks runtime translation
  values only — the `upstream-frontend:<path>@<sha>` provenance comments in file
  headers (and this README) are outside any value string and are not
  covered by (or a violation of) this guard.
- `src/get-translation.test.ts`, `src/resolve-api-locale.test.ts` — helper
  behavior (locale fallback, Accept-Language parsing, label lookup).

Run with `pnpm vitest run packages/i18n` from the repo root (or `pnpm test`
for the whole monorepo).
