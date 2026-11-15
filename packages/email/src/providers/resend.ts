// megaui:libs/email/providers/resend.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-07 task card):
// - Upstream lazily constructs a module-level singleton `Resend` instance
//   from `@config` (GC-07: implicit env-backed singleton). This port takes
//   an explicit `ResendProviderConfig` and exposes a `client` test seam
//   (`ResendClientLike`) so unit tests can stub `emails.send` without a
//   real network call or the real `resend` package's constructor.
import { Resend } from "resend";
import type { EmailOptions, EmailProviderClient, EmailResponse } from "../types";

export type ResendSendPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
};

export type ResendSendResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

/** Test seam — any object with this shape (incl. a real `Resend` instance) works. */
export interface ResendClientLike {
  emails: {
    send(payload: ResendSendPayload): Promise<ResendSendResult>;
  };
}

export interface ResendProviderConfig {
  apiKey: string;
}

export interface CreateResendEmailProviderOptions {
  config: ResendProviderConfig;
  /** Test seam — defaults to a real `Resend` client built from `config.apiKey`. */
  client?: ResendClientLike;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`[@megaui/email] resend ${name} is required (GC-07 fail-closed)`);
  }
  return value;
}

export function createResendEmailProvider(options: CreateResendEmailProviderOptions): EmailProviderClient {
  requireNonEmpty(options.config.apiKey, "apiKey");
  const client: ResendClientLike = options.client ?? new Resend(options.config.apiKey);

  return {
    async send(mailOptions: EmailOptions): Promise<EmailResponse> {
      try {
        const { data, error } = await client.emails.send({
          from: mailOptions.from,
          to: mailOptions.to,
          subject: mailOptions.subject,
          html: mailOptions.html,
          text: mailOptions.text,
          cc: mailOptions.cc,
          bcc: mailOptions.bcc,
          replyTo: mailOptions.replyTo,
        });

        if (error) {
          return {
            success: false,
            error: { message: error.message, name: "ResendError", provider: "resend" },
          };
        }

        return { success: true, id: data?.id };
      } catch (error) {
        return {
          success: false,
          error: {
            message: error instanceof Error ? error.message : "Unknown resend error",
            name: "ResendError",
            provider: "resend",
          },
        };
      }
    },
  };
}
