// megaui-only: "reset your password" message.
import { buildActionEmail } from "./action-email";
import { resolveLocale } from "./resolve-locale";
import type { EmailTemplate } from "./types";

export interface ResetPasswordEmailParams {
  name: string;
  resetUrl: string;
  expiryHours: number;
  /** Product name shown in the header (no built-in brand default — pass explicitly). */
  appName: string;
  locale?: string;
}

export function generateResetPasswordEmail(params: ResetPasswordEmailParams): EmailTemplate {
  return buildActionEmail({
    kind: "resetPassword",
    locale: resolveLocale(params.locale),
    appName: params.appName,
    recipientName: params.name,
    actionUrl: params.resetUrl,
    expiryHours: params.expiryHours,
  });
}
