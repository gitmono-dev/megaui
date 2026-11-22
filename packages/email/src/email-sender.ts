// megaui:libs/email/templates-sender.ts@0ff3a9d
// megaui:libs/email/email-sender.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-07 task card):
// - No brand-domain defaultFrom fallback — `defaultFrom` is required
//   (GC-07 / ADR brand strip).
// - Provider set narrowed to test/smtp/resend via createEmailProvider.
// - Explicit EmailSenderConfig instead of @config singleton.

import { createEmailProvider, type EmailProviderConfig } from "./provider-factory";
import {
  generateProductNotificationEmail,
  type ProductNotificationParams,
  type ProductNotificationResult,
} from "./templates/product-notifications";
import { generateResetPasswordEmail, type ResetPasswordEmailParams } from "./templates/reset-password";
import { generateVerificationEmail, type VerificationEmailParams } from "./templates/verification";
import type { EmailOptions, EmailProviderClient, EmailResponse } from "./types";

/** No brand default (ADR brand strip) — deployment must set this explicitly, e.g. via `EMAIL_DEFAULT_FROM`. */
export interface EmailSenderConfig {
  defaultFrom: string;
  provider: EmailProviderConfig;
}

export type SendEmailOptions = Omit<EmailOptions, "from"> & { from?: string };

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`[@megaui/email] ${name} is required (GC-07 fail-closed — no brand default)`);
  }
  return value;
}

function containsCompatibilityRecipient(value: string | string[] | undefined): boolean {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.some(entry => /(?:^|[<@\s])identity\.invalid(?:[>\s,;]|$)/iu.test(entry));
}

export class EmailSender {
  private readonly provider: EmailProviderClient;
  private readonly defaultFrom: string;

  constructor(config: EmailSenderConfig) {
    this.defaultFrom = requireNonEmpty(config.defaultFrom, "defaultFrom");
    this.provider = createEmailProvider(config.provider);
  }

  async sendEmail(options: SendEmailOptions): Promise<EmailResponse> {
    if (containsCompatibilityRecipient(options.to)
      || containsCompatibilityRecipient(options.cc)
      || containsCompatibilityRecipient(options.bcc)) {
      throw new Error("EMAIL_COMPATIBILITY_ADDRESS_REJECTED");
    }
    return this.provider.send({ ...options, from: options.from || this.defaultFrom });
  }

  async sendVerificationEmail(
    to: string,
    params: VerificationEmailParams,
    options: Omit<SendEmailOptions, "to" | "subject" | "html"> = {},
  ): Promise<EmailResponse> {
    const { subject, html } = generateVerificationEmail(params);
    return this.sendEmail({ to, subject, html, ...options });
  }

  async sendResetPasswordEmail(
    to: string,
    params: ResetPasswordEmailParams,
    options: Omit<SendEmailOptions, "to" | "subject" | "html"> = {},
  ): Promise<EmailResponse> {
    const { subject, html } = generateResetPasswordEmail(params);
    return this.sendEmail({ to, subject, html, ...options });
  }

  /**
   * Business-payload validation (missing/blank event field) returns an
   * explicit `{ ok: false }` result rather than sending — this is an
   * expected, recoverable case (unlike a missing *template* variable,
   * which is a programming error and throws per GC-11 — see `render.ts`).
   */
  async sendProductNotificationEmail(
    to: string,
    params: ProductNotificationParams,
    options: Omit<SendEmailOptions, "to" | "subject" | "html"> = {},
  ): Promise<{ ok: true; response: EmailResponse } | { ok: false; code: "invalid_payload"; message: string }> {
    const result: ProductNotificationResult = generateProductNotificationEmail(params);
    if (!result.ok) {
      return result;
    }
    const response = await this.sendEmail({
      to,
      subject: result.template.subject,
      html: result.template.html,
      ...options,
    });
    return { ok: true, response };
  }
}

export function createEmailSender(config: EmailSenderConfig): EmailSender {
  return new EmailSender(config);
}
