// megaui-only: "confirm your email address" message.
import { buildActionEmail } from "./action-email";
import { resolveLocale } from "./resolve-locale";
import type { EmailTemplate } from "./types";

export interface VerificationEmailParams {
  name: string;
  verificationUrl: string;
  expiryHours: number;
  /** Product name shown in the header (no built-in brand default — pass explicitly). */
  appName: string;
  locale?: string;
}

export function generateVerificationEmail(params: VerificationEmailParams): EmailTemplate {
  return buildActionEmail({
    kind: "verification",
    locale: resolveLocale(params.locale),
    appName: params.appName,
    recipientName: params.name,
    actionUrl: params.verificationUrl,
    expiryHours: params.expiryHours,
  });
}
