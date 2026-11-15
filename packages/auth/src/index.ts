export {
  createAuth,
  toNextJsHandler,
  type Auth,
  type CreateAuthConfig,
} from "./create-auth";
export {
  resolveAuthTrustedOrigins,
  resolveAuthTrustedOriginsFromEnv,
  type TrustedOriginsSources,
} from "./trusted-origins";
export {
  resolveSocialProviders,
  resolveSocialProvidersFromEnv,
  type OAuthClientCredentials,
  type ResolvedSocialProviders,
  type SocialProvidersInput,
} from "./social-providers";
export { getRefererInfo, type RefererInfo } from "./referer-info";
export {
  assertAllowedUserImageUrl,
  UserImageValidationError,
  type AssertAllowedUserImageUrlOptions,
  type UserImageErrorCode,
} from "./user-image-url";
export {
  ENTERPRISE_OTP_ALPHABET,
  ENTERPRISE_OTP_LENGTH,
  generateEnterpriseOtpCode,
} from "./enterprise-otp/code";
export { createEnterpriseOtpCrypto } from "./enterprise-otp/crypto";
export {
  createEnterpriseOtpConsumer,
  type EnterpriseOtpConsumer,
  type EnterpriseOtpConsumerOptions,
  type EnterpriseOtpConsumeInput,
} from "./enterprise-otp/consume";
export { createEnterpriseSession, ENTERPRISE_SESSION_TTL_MS } from "./enterprise-otp/verify";
export {
  createEnterprisePairingStatus,
  type EnterprisePairingStatusPort,
  type EnterprisePairingStatusPortResult,
  type EnterprisePairingStatusResult,
} from "./enterprise-otp/status";
export type {
  EnterpriseOtpBinding,
  EnterpriseOtpCryptoConfig,
  EnterpriseOtpCrypto,
  EnterpriseOtpDigest,
  EnterpriseOtpDelivery,
  EnterpriseOtpGrant,
  EnterpriseOtpVerifyPort,
  EnterpriseOtpVerifyPortResult,
} from "./enterprise-otp/types";
export {
  AUTH_ROUTE_PREFIX,
  ENTERPRISE_AUTH_OPERATIONS,
  createEnterpriseOperationPolicy,
  isEnterpriseAuthOperation,
  type EnterpriseAuthOperation,
  type EnterpriseOperationMode,
  type EnterpriseOperationPolicyOptions,
} from "./enterprise-otp/policy";
export {
  createEnterpriseSessionPlugin,
  type EnterprisePublicProfile,
  type EnterprisePublicSession,
  type EnterprisePublicSessionUser,
  type EnterpriseSessionAuthority,
  type EnterpriseSessionPluginOptions,
} from "./enterprise-otp/public-session";

// Browser / client entry lives at `@megaui/auth/client` so importing the
// root barrel never pulls Node-only `pg` / drizzle into a client bundle.
