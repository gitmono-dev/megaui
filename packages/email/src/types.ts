// megaui:libs/email/types.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-07 task card):
// - `EmailProvider` union narrowed to `"test" | "smtp" | "resend"` — no
//   `cloudflare` / `sendgrid` / `mailchimp` (product-scope strip, ADR
//   brand/vendor strip; those three were either unimplemented stubs or a
//   Cloudflare-Workers-only binding not applicable to this Node target).
export type EmailProvider = "test" | "smtp" | "resend";

export interface EmailOptions {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export interface EmailResponse {
  success: boolean;
  id?: string;
  error?: {
    message: string;
    name: string;
    provider?: EmailProvider;
  };
}

/** Uniform provider send seam — every provider (test/smtp/resend) implements this. */
export interface EmailProviderClient {
  send(options: EmailOptions): Promise<EmailResponse>;
}
