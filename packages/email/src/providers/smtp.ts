// megaui:libs/email/providers/smtp.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-07 task card):
// - Upstream hand-rolls the SMTP wire protocol over a raw `node:net` socket
//   (EHLO/MAIL FROM/RCPT TO/DATA state machine + multiline reply parsing)
//   to stay dependency-free for a Cloudflare-Workers-adjacent runtime. This
//   product targets Node only (no Workers), so this port uses `nodemailer`
//   for the real transport and keeps the same injectable-transport test
//   seam upstream had (`transport` option), rather than re-implementing
//   and re-testing a bespoke SMTP client.
// - Config is explicit (`SmtpProviderConfig`); no `@config` / env singleton
//   (GC-07 fail-closed — see also PK-08 `S3StorageConfig`).
import { createTransport } from "nodemailer";
import type { EmailOptions, EmailProviderClient, EmailResponse } from "../types";

export type SmtpMailPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
};

/** Test seam — any object with this shape (incl. a real nodemailer transporter) works. */
export interface SmtpTransport {
  sendMail(mail: SmtpMailPayload): Promise<{ messageId?: string }>;
}

export interface SmtpProviderConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
}

export interface CreateSmtpEmailProviderOptions {
  config: SmtpProviderConfig;
  /** Test seam — defaults to a real nodemailer transport built from `config`. */
  transport?: SmtpTransport;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`[@megaui/email] smtp ${name} is required (GC-07 fail-closed)`);
  }
  return value;
}

export function createSmtpEmailProvider(options: CreateSmtpEmailProviderOptions): EmailProviderClient {
  const cfg = options.config;
  requireNonEmpty(cfg.host, "host");
  if (!cfg.port) {
    throw new Error("[@megaui/email] smtp port is required (GC-07 fail-closed)");
  }

  const transport: SmtpTransport =
    options.transport ??
    createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? false,
      auth: cfg.auth,
    });

  return {
    async send(mailOptions: EmailOptions): Promise<EmailResponse> {
      try {
        const result = await transport.sendMail({
          from: mailOptions.from,
          to: mailOptions.to,
          subject: mailOptions.subject,
          html: mailOptions.html,
          text: mailOptions.text,
          cc: mailOptions.cc,
          bcc: mailOptions.bcc,
          replyTo: mailOptions.replyTo,
        });
        return { success: true, id: result.messageId };
      } catch (error) {
        return {
          success: false,
          error: {
            message: error instanceof Error ? error.message : "Unknown SMTP error",
            name: "SmtpError",
            provider: "smtp",
          },
        };
      }
    },
  };
}
