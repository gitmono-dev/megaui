// megaui-only: builder shared by the "click this link" emails (verify address,
// reset password). Both use the same layout and the same copy fields; only the
// dictionary entry and the target URL differ.
import { translations, type SupportedLocale } from "@megaui/i18n";

import { renderTemplate } from "../render";
import { renderEmailShell } from "./shell";
import type { EmailTemplate } from "./types";

/** Dictionary entries that follow the shared action-email copy shape. */
export type ActionEmailKind = "verification" | "resetPassword";

export interface ActionEmailInput {
  kind: ActionEmailKind;
  locale: SupportedLocale;
  appName: string;
  recipientName: string;
  actionUrl: string;
  expiryHours: number;
}

export function buildActionEmail(input: ActionEmailInput): EmailTemplate {
  const copy = translations[input.locale].email[input.kind];
  const currentYear = String(new Date().getFullYear());

  const html = renderEmailShell(
    {
      appName: input.appName,
      title: copy.title,
      greeting: renderTemplate(copy.greeting, { name: input.recipientName }),
      message: copy.message,
      ctaLabel: copy.button,
      ctaUrl: input.actionUrl,
      alternativeText: copy.alternativeText,
      secondaryLine: renderTemplate(copy.expiry, { expiry_hours: input.expiryHours }),
      disclaimer: copy.disclaimer,
      signature: copy.signature,
      copyright: renderTemplate(copy.copyright, { year: currentYear }),
    },
    input.locale,
  );

  return { subject: copy.subject, html };
}
