# `@megaui/email`

Provider-agnostic transactional email sending for megaui (PK-07): a
provider factory (`test` in-memory capture / `smtp` / `resend`), bilingual
HTML templates (verification, reset password, product notifications), and
an `EmailSender` that ties both together with explicit, fail-closed
configuration (GC-07 — no `@config` singleton, no brand-domain default).

## Provenance (GC-03)

Ported surfaces carry a GC-03 provenance header such as
`megaui:libs/email/types.ts@0ff3a9d`. Baseline SHA `0ff3a9d` (plan `REF-07`).

| File | Source path (under REF-07) |
|---|---|
| `src/types.ts` | `libs/email/types.ts` |
| `src/render.ts` | `libs/email/templates/render.ts` |
| `src/providers/test.ts` | `libs/email/providers/test.ts` |
| `src/providers/smtp.ts` | `libs/email/providers/smtp.ts` |
| `src/providers/resend.ts` | `libs/email/providers/resend.ts` |
| `src/provider-factory.ts` | `libs/email/email-sender.ts` |
| `src/email-sender.ts` | `libs/email/templates-sender.ts` + `libs/email/email-sender.ts` |
| `src/templates/verification.ts` | `libs/email/templates/templates.ts` |
| `src/templates/reset-password.ts` | `libs/email/templates/templates.ts` |
| `src/templates/product-notifications.ts` | `libs/email/templates/product-notifications.ts` |
| `src/templates/shell.ts` | megaui-only (see "Diffs vs upstream") |

`src/provenance.test.ts` guards production sources: every token matching the
OPS-02 extractor must be a valid path@sha provenance form.

## Diffs vs upstream (intentional — registered on the PK-07 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `EmailProvider` = `resend \| cloudflare \| sendgrid \| mailchimp \| smtp \| test` | Narrowed to `test \| smtp \| resend` | Card scope: no cloudflare/sendgrid/mailchimp. `sendgrid`/`mailchimp` were unimplemented stubs upstream; `cloudflare` is a Workers-only binding not applicable to this Node target. |
| `DEFAULT_FROM = config.email.defaultFrom \|\| '<upstream's branded default>'` (`@config` singleton, see REF-07 `libs/email/templates-sender.ts:12`) | `EmailSenderConfig.defaultFrom` is required; constructor throws if empty | GC-07 fail-closed + ADR brand strip — no brand-domain fallback of any kind. Deployments must set `EMAIL_DEFAULT_FROM` (or equivalent) explicitly. |
| `renderTemplate`'s `getValue` returns `''` for any unresolved dot-path (silent blank text) | `renderTemplate` throws `EmailTemplateRenderError` for a missing/`undefined`/`null` path | GC-11 fail-closed — a missing template variable is a bug, not something to paper over with blank output. |
| Hand-rolled raw-socket SMTP client (`node:net` EHLO/MAIL FROM/RCPT TO/DATA state machine + multiline reply parser), written to stay dependency-free for a Workers-adjacent runtime | Uses `nodemailer` for the real transport | This product targets Node only (no Cloudflare Workers); reusing a maintained SMTP client avoids re-implementing and re-testing the wire protocol. The same injectable-transport test seam (`transport` option) is kept. |
| Module-level `Resend` singleton built from `@config` | Explicit `ResendProviderConfig` + injectable `client` seam | GC-07 — no env-backed singleton; tests inject a stub client, no real network call. |
| `test` provider keeps recordings in module-level mutable state (`const recorded: RecordedTestEmail[] = []`), shared across every import | `createTestEmailProvider()` factory — each call gets its own isolated in-memory store | GC-09 (unisolated global state) — no risk of test bleed-through, no manual `clearTestEmailRecordings()` step to remember. |
| Three near-identical hand-written MJML documents (verification / reset password / product notification), compiled to static HTML at build time via a dedicated `mjml` compile step (`compile.ts` → `compiled.ts`) | One shared hand-written HTML/inline-CSS shell (`templates/shell.ts`), reused by all three generators; no `mjml` build dependency | Not required by the PK-07 ACs; removes an entire build-step dependency chain (`mjml` + `html-minifier`/`uglify-js`/`clean-css`) for a single shared template (GC-02 single source of truth). |
| Product notifications cover 9 event types incl. `workspace.mention`/`reply`/`dm`/`invite` | Only the 5 CL/Issue/reference event types already registered in `@megaui/i18n`'s `workspace.settings.notificationsPage.eventLabels` | Card scope is "CL/Issue/doc events"; chat (`EG-07`) and the notification HTTP entry (`WA-05`) are separate cards. |
| Product notification per-event copy (`subject`/`title`/`message`/verb phrases) lives in a bilingual dictionary inside `libs/email` | Event *titles* come from the existing `@megaui/i18n` `eventLabels` key; `greeting`/`alternativeText`/`signature`/`copyright` are reused from `@megaui/i18n`'s `email.verification` namespace (generic transactional boilerplate, not verification-specific); `message` is built from dynamic values only (no invented verb-phrase dictionary); the CTA label and a generic non-"you requested this" disclaimer are the two small pieces of copy defined locally (`LOCAL_COPY` in `product-notifications.ts`) | This card's write set (`packages/email/src/**`) does not include `packages/i18n`, and no `email.productNotification*` namespace exists there yet. Registered here as an explicit, intentional scope decision rather than inventing an unreviewed i18n surface out-of-band. |

## Usage

```ts
import { createEmailSender } from "@megaui/email";

const sender = createEmailSender({
  defaultFrom: process.env.EMAIL_DEFAULT_FROM!, // required — no brand default
  provider: { kind: "smtp", config: { host: process.env.SMTP_HOST!, port: 587 } },
  // or: provider: { kind: "resend", config: { apiKey: process.env.RESEND_API_KEY! } }
  // or: provider: { kind: "test" } // in-memory capture, for tests/dev
});

await sender.sendVerificationEmail(user.email, {
  name: user.name,
  verificationUrl,
  expiryHours: 24,
  appName: "Mega",
  locale: user.locale,
});

await sender.sendResetPasswordEmail(user.email, {
  name: user.name,
  resetUrl,
  expiryHours: 2,
  appName: "Mega",
  locale: user.locale,
});

const result = await sender.sendProductNotificationEmail(user.email, {
  eventType: "cl.merged",
  recipientUsername: user.username,
  ctaUrl,
  appName: "Mega",
  payload: { actorUsername: "reviewer1", clLink: "CL-42", clTitle: "Fix bug" },
  locale: user.locale,
});
if (!result.ok) {
  // result.code === "invalid_payload" — payload was missing a required field for this event type.
}
```

### Testing with the `test` provider

```ts
import { createEmailSender, createTestEmailProvider } from "@megaui/email";

const testProvider = createTestEmailProvider();
const sender = createEmailSender({
  defaultFrom: "hello@deploy.example.com",
  provider: { kind: "test", provider: testProvider },
});

await sender.sendVerificationEmail(/* ... */);
expect(testProvider.getLast()?.subject).toBe(/* ... */);
```

`smtp`/`resend` similarly accept a `transport`/`client` seam
(`SmtpTransport` / `ResendClientLike`) for unit tests — see
`src/providers/smtp.test.ts` and `src/providers/resend.test.ts`. No test in
this package performs a real network send.

## Fail-closed rendering (GC-11)

`renderTemplate` (and every template generator built on it) throws
`EmailTemplateRenderError` when a template variable is missing,
`undefined`, or `null` — an explicitly-provided empty string (`""`) is a
valid value and renders as empty text. This applies to `generateVerificationEmail` / `generateResetPasswordEmail` /
`generateProductNotificationEmail` alike: a missing/blank *business*
payload field (e.g. a product-notification event missing `clLink`) is
reported as an explicit `{ ok: false, code: "invalid_payload" }` result
(an expected, recoverable case), while a missing *template* variable
(a programming error) throws.

## Tests

- `src/render.test.ts` — escaping (double vs triple brace), dot-path
  lookup, fail-closed on missing/`undefined`/`null` (AC 3).
- `src/providers/test.test.ts` — in-memory capture provider: records,
  `getAll`/`getLast`/`clear`, isolation across instances (AC 1).
- `src/providers/smtp.test.ts`, `src/providers/resend.test.ts` — interface
  stubs only, no real send: success/error mapping, config validation
  (AC 1).
- `src/provider-factory.test.ts` — factory wiring for all three provider
  kinds.
- `src/templates/verification.test.ts`, `reset-password.test.ts`,
  `product-notifications.test.ts` — bilingual render, HTML-escaping of
  untrusted values, fail-closed on missing variables (AC 2, AC 3).
- `src/brand-residue.test.ts` — every template × locale combination has
  zero brand-word hits (`legacy-demo-brand` / upstream product name) in the *rendered output* (AC 2).
- `src/provenance.test.ts` — every production source file has zero
  `legacy-demo-brand` zero hits and only provenance-form tokens in production sources (GC-03).
- `src/email-sender.test.ts` — explicit-config fail-closed behavior,
  `from` fallback/override, end-to-end send through the `test` provider.

Run with `pnpm vitest run packages/email` from the repo root.
