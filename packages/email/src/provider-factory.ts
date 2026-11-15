// megaui:libs/email/email-sender.ts@0ff3a9d

import { createResendEmailProvider, type ResendClientLike, type ResendProviderConfig } from "./providers/resend";
import { createSmtpEmailProvider, type SmtpProviderConfig, type SmtpTransport } from "./providers/smtp";
import { createTestEmailProvider, type TestEmailProvider } from "./providers/test";
import type { EmailProviderClient } from "./types";

export type EmailProviderConfig =
  | { kind: "test"; provider?: TestEmailProvider }
  | { kind: "smtp"; config: SmtpProviderConfig; transport?: SmtpTransport }
  | { kind: "resend"; config: ResendProviderConfig; client?: ResendClientLike };

/**
 * Provider factory: `test` (in-memory capture) / `smtp` / `resend` only.
 *
 * Each branch accepts an injectable test seam (`provider` / `transport` /
 * `client`) so callers can construct their own stub and keep a reference
 * for assertions, instead of relying on shared module-level state.
 */
export function createEmailProvider(providerConfig: EmailProviderConfig): EmailProviderClient {
  switch (providerConfig.kind) {
    case "test":
      return providerConfig.provider ?? createTestEmailProvider();
    case "smtp":
      return createSmtpEmailProvider({ config: providerConfig.config, transport: providerConfig.transport });
    case "resend":
      return createResendEmailProvider({ config: providerConfig.config, client: providerConfig.client });
    default: {
      const exhaustive: never = providerConfig;
      throw new Error(`[@megaui/email] unsupported provider: ${JSON.stringify(exhaustive)}`);
    }
  }
}
