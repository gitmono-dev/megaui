// megaui:libs/email/templates/product-notifications.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-07 task card):
// - Upstream's `PRODUCT_EVENT_TYPES` includes five `workspace.*` chat
//   events (`workspace.mention` / `workspace.reply` / `workspace.dm` /
//   `workspace.invite`) alongside the CL/Issue/reference events. The card
//   scopes this surface to "CL/Issue/doc events" only; chat (`EG-07`) and
//   the notification HTTP entry (`WA-05`) are separate, later cards, so
//   this port keeps only the five event types already registered in
//   `@megaui/i18n`'s `workspace.settings.notificationsPage.eventLabels`
//   (`cl.comment.created` / `cl.merged` / `issue.comment.created` /
//   `issue.closed` / `item.referenced`) — no invented new i18n surface.
// - Event *titles* come from that existing i18n key (bilingual). The rest
//   of the per-event copy (`subject/message`) is built here purely from
//   the localized title plus interpolated dynamic values (actor/links/
//   excerpts) — no new bilingual verb-phrase dictionary is invented,
//   because this task's write set (PK-07 card) does not include
//   `packages/i18n`. `greeting` / `alternativeText` / `signature` /
//   `copyright` are reused verbatim from `@megaui/i18n`'s
//   `email.verification` namespace, which is generic transactional-email
//   boilerplate (not verification-specific wording). `disclaimer` and the
//   CTA button label are the two small pieces of copy that genuinely
//   don't exist anywhere in `@megaui/i18n` yet (every existing disclaimer
//   is phrased around "you requested this" flows, and there is no generic
//   "View" action string) — those are defined locally below
//   (`LOCAL_COPY`) and are registered here as an explicit, intentional
//   PK-07 scope decision rather than silently duplicating dictionary
//   content.
import { translations, type SupportedLocale } from "@megaui/i18n";
import { renderTemplate } from "../render";
import { resolveLocale } from "./resolve-locale";
import { renderEmailShell } from "./shell";
import type { EmailTemplate } from "./types";

export const PRODUCT_EVENT_TYPES = [
  "cl.comment.created",
  "cl.merged",
  "issue.comment.created",
  "issue.closed",
  "item.referenced",
] as const;

export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number];

export function isProductEventType(value: string): value is ProductEventType {
  return (PRODUCT_EVENT_TYPES as readonly string[]).includes(value);
}

const REQUIRED_PAYLOAD_FIELDS: Record<ProductEventType, readonly string[]> = {
  "cl.comment.created": ["actorUsername", "clLink", "commentExcerpt"],
  "cl.merged": ["actorUsername", "clLink", "clTitle"],
  "issue.comment.created": ["actorUsername", "issueLink", "issueTitle", "commentExcerpt"],
  "issue.closed": ["actorUsername", "issueLink", "issueTitle"],
  "item.referenced": ["actorUsername", "referencedLink", "sourceLink"],
};

/** Not present anywhere in `@megaui/i18n` yet — see file header. */
const LOCAL_COPY: Record<SupportedLocale, { viewLabel: string; disclaimer: string }> = {
  en: {
    viewLabel: "View",
    disclaimer: "If you were not expecting this notification, you can ignore this email.",
  },
  "zh-CN": {
    viewLabel: "查看",
    disclaimer: "如果你没有预期收到此通知，可以忽略这封邮件。",
  },
};

// Double-brace placeholders here go through `renderTemplate`'s HTML
// escaping — these values are untrusted, user-authored content (actor
// display names, comment excerpts), unlike the static translator-authored
// `@megaui/i18n` copy used elsewhere in this package.
const MESSAGE_TEMPLATES: Record<ProductEventType, string> = {
  "cl.comment.created": "{{actorUsername}} — {{clLink}}: {{commentExcerpt}}",
  "cl.merged": "{{actorUsername}} — {{clLink}} ({{clTitle}})",
  "issue.comment.created": "{{actorUsername}} — {{issueLink}}: {{commentExcerpt}}",
  "issue.closed": "{{actorUsername}} — {{issueLink}} ({{issueTitle}})",
  "item.referenced": "{{actorUsername}} — {{referencedLink}} → {{sourceLink}}",
};

function buildMessage(eventType: ProductEventType, v: Record<string, string>): string {
  return renderTemplate(MESSAGE_TEMPLATES[eventType], v);
}

function primaryLink(eventType: ProductEventType, v: Record<string, string>): string {
  switch (eventType) {
    case "cl.comment.created":
    case "cl.merged":
      return v.clLink ?? "";
    case "issue.comment.created":
    case "issue.closed":
      return v.issueLink ?? "";
    case "item.referenced":
      return v.referencedLink ?? "";
    default: {
      const exhaustive: never = eventType;
      return exhaustive;
    }
  }
}

function requireStringFields(
  payload: Record<string, unknown>,
  fields: readonly string[],
): { ok: true; values: Record<string, string> } | { ok: false; missing: string } {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const raw = payload[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, missing: field };
    }
    values[field] = raw;
  }
  return { ok: true, values };
}

export interface ProductNotificationParams {
  eventType: ProductEventType;
  recipientUsername: string;
  /** Absolute URL the CTA button links to (deep link into the product). */
  ctaUrl: string;
  /** Product name shown in the header (no built-in brand default — pass explicitly). */
  appName: string;
  payload: Record<string, unknown>;
  locale?: string;
}

export type ProductNotificationResult =
  | { ok: true; template: EmailTemplate }
  | { ok: false; code: "invalid_payload"; message: string };

/** Render a product notification for an allowlisted CL/Issue/reference event. */
export function generateProductNotificationEmail(params: ProductNotificationParams): ProductNotificationResult {
  const required = REQUIRED_PAYLOAD_FIELDS[params.eventType];
  const checked = requireStringFields(params.payload, required);
  if (!checked.ok) {
    return { ok: false, code: "invalid_payload", message: `payload.${checked.missing} is required` };
  }

  const locale = resolveLocale(params.locale);
  const t = translations[locale];
  const eventLabel = t.workspace.settings.notificationsPage.eventLabels[params.eventType];
  const local = LOCAL_COPY[locale];
  const verificationCopy = t.email.verification;
  const year = new Date().getFullYear().toString();

  const subject = `${eventLabel}: ${primaryLink(params.eventType, checked.values)}`;
  const message = buildMessage(params.eventType, checked.values);
  const copyright = renderTemplate(verificationCopy.copyright, { year });
  const greeting = renderTemplate(verificationCopy.greeting, { name: params.recipientUsername });

  const html = renderEmailShell(
    {
      appName: params.appName,
      title: eventLabel,
      greeting,
      message,
      ctaLabel: local.viewLabel,
      ctaUrl: params.ctaUrl,
      alternativeText: verificationCopy.alternativeText,
      secondaryLine: "",
      disclaimer: local.disclaimer,
      signature: verificationCopy.signature,
      copyright,
    },
    locale,
  );

  return { ok: true, template: { subject, html } };
}
