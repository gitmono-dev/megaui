export {
  AUTH_ROUTE_PREFIX,
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
  FEISHU_LOGIN_CODE_ALPHABET,
  FEISHU_LOGIN_CODE_LENGTH,
  generateFeishuLoginCode,
} from "./feishu-login/code";
export {
  FEISHU_LOGIN_PLUGIN_ID,
  FEISHU_LOGIN_REQUEST_PATH,
  feishuLogin,
  type FeishuLoginPluginOptions,
} from "./feishu-login/plugin";
export {
  FEISHU_LOGIN_ISSUE_FAILED,
  type FeishuLoginIssueInput,
  type FeishuLoginIssuePort,
  type FeishuLoginRequestLogKey,
} from "./feishu-login/request";
export {
  FEISHU_LOGIN_FLOW_COOKIE,
  FEISHU_LOGIN_FLOW_MAX_AGE_SECONDS,
} from "./feishu-login/cookie";

// Browser / client entry lives at `@megaui/auth/client` so importing the
// root barrel never pulls Node-only `pg` / drizzle into a client bundle.
