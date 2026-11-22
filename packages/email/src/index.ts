export type { EmailOptions, EmailProvider, EmailProviderClient, EmailResponse } from "./types";
export { EmailTemplateRenderError, renderTemplate } from "./render";

export { createEmailProvider, type EmailProviderConfig } from "./provider-factory";
export {
  createTestEmailProvider,
  type RecordedTestEmail,
  type TestEmailProvider,
} from "./providers/test";
export {
  createSmtpEmailProvider,
  type SmtpMailPayload,
  type SmtpProviderConfig,
  type SmtpTransport,
} from "./providers/smtp";
export {
  createResendEmailProvider,
  type ResendClientLike,
  type ResendProviderConfig,
  type ResendSendPayload,
  type ResendSendResult,
} from "./providers/resend";

export { createEmailSender, EmailSender, type EmailSenderConfig, type SendEmailOptions } from "./email-sender";

export { generateVerificationEmail, type VerificationEmailParams } from "./templates/verification";
export { generateResetPasswordEmail, type ResetPasswordEmailParams } from "./templates/reset-password";
export {
  generateProductNotificationEmail,
  isProductEventType,
  PRODUCT_EVENT_TYPES,
  type ProductEventType,
  type ProductNotificationParams,
  type ProductNotificationResult,
} from "./templates/product-notifications";
export type { EmailTemplate } from "./templates/types";
