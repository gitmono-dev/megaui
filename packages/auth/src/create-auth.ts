// megaui:libs/auth/auth.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-06 task card):
// - Factory `createAuth(config)` with explicit deps (db, email, secret,
//   baseURL, appName) instead of `@config` / `@libs/*` singletons.
// - Removed wechat plugin, phoneNumber plugin, captcha plugin, and the
//   validation-better-auth adapter (validators package not in megaui;
//   WA-02 can add client-side validation). No upstream phone temp-email
//   domains.
// - Social providers opt-in via `resolveSocialProviders` (default off).
// - Kept better-auth `admin` plugin (schema fields retained in PK-04).
// - Email hooks call `@megaui/email` EmailSender (camelCase template
//   params + required `appName`).
// - PG-only drizzle adapter (ADR-ARCH-02).
// - No brand appName default — `appName` is required on config.

import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import type { Database } from "@megaui/database";
import { account, session, user, verification } from "@megaui/database";
import type { EmailSender } from "@megaui/email";
import { getTranslation, defaultLocale, type SupportedLocale } from "@megaui/i18n";

import { getRefererInfo } from "./referer-info";
import {
  resolveSocialProviders,
  type SocialProvidersInput,
} from "./social-providers";
import {
  resolveAuthTrustedOrigins,
  type TrustedOriginsSources,
} from "./trusted-origins";
import {
  assertAllowedUserImageUrl,
  UserImageValidationError,
} from "./user-image-url";
import {
  FEISHU_LOGIN_REQUEST_PATH,
  feishuLogin,
  feishuLoginRequestRateLimitRule,
  type FeishuLoginPluginOptions,
} from "./feishu-login/plugin";
import { createFeishuLoginOperationPolicy } from "./feishu-login/policy";

/** The HTTP route prefix the Web mounts the auth handler under (`/api/auth/[...all]`). */
export const AUTH_ROUTE_PREFIX = "/api/auth";

export interface CreateAuthConfig {
  /** Display name in auth emails / better-auth `appName` (required — no brand default). */
  appName: string;
  /** better-auth secret (`BETTER_AUTH_SECRET`). */
  secret: string;
  /** Canonical auth base URL (`BETTER_AUTH_URL`). */
  baseURL: string;
  db: Database;
  email: EmailSender;
  /** Hours advertised in verification / reset emails. @default 1 */
  emailExpiryHours?: number;
  requireEmailVerification?: boolean;
  socialProviders?: SocialProvidersInput;
  trustedOrigins?: TrustedOriginsSources;
  /**
   * Optional public object-store base (`S3_PUBLIC_URL`) used to allow http
   * avatar URLs under that prefix. https URLs are always allowed.
   */
  allowedImagePublicUrlBase?: string;
  /** Override NODE_ENV-driven rate limit / dev hooks. */
  nodeEnv?: string;
  /**
   * FSL-123: the Feishu login request endpoint (`POST /feishu-login/request`). The plugin is
   * registered only when this is passed; Better Auth's per-address rate limit still applies to
   * admissible requests, while invalid inputs answer 400 ahead of it (ADR-FSL-11 order).
   * FSL-127: passing it also registers the Feishu-mode operation allowlist ahead of every other
   * plugin (only `/feishu-login/request`, `/feishu-login/verify`, `/get-session` and `/sign-out`
   * stay reachable, over HTTP and through direct `auth.api` calls).
   * FSL-133: the old enterprise options (pairing, operation policy, session projection) are gone.
   */
  feishuLogin?: FeishuLoginPluginOptions;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(
      `[@megaui/auth] ${name} is required (GC-07 fail-closed — no brand/default fallback)`,
    );
  }
  return value.trim();
}

function attachDevContext(
  request: Request | undefined,
  key: "verificationUrl" | "resetUrl",
  url: string,
  nodeEnv: string,
): void {
  if (nodeEnv !== "development" || !request) return;
  const req = request as Request & { context?: Record<string, string> };
  req.context = req.context ?? {};
  req.context[key] = url;
}

/**
 * Build a better-auth instance for megaui (PG drizzle adapter + email hooks).
 */
export function createAuth(config: CreateAuthConfig) {
  const appName = requireNonEmpty(config.appName, "appName");
  const secret = requireNonEmpty(config.secret, "secret");
  const baseURL = requireNonEmpty(config.baseURL, "baseURL");
  const emailExpiryHours = config.emailExpiryHours ?? 1;
  const requireEmailVerification = config.requireEmailVerification ?? false;
  const nodeEnv = config.nodeEnv ?? process.env.NODE_ENV ?? "production";
  const socialProviders = resolveSocialProviders(config.socialProviders ?? {});
  const trustedOriginsSources = config.trustedOrigins ?? {};
  const imagePublicUrlBase = config.allowedImagePublicUrlBase;

  function normalizePersistedUserImage(image: string | null | undefined): string | null {
    try {
      const normalized = assertAllowedUserImageUrl(image, {
        publicUrlBase: imagePublicUrlBase,
      });
      return normalized === "" ? null : normalized;
    } catch (error) {
      if (error instanceof UserImageValidationError) {
        throw new APIError("BAD_REQUEST", {
          code: error.code,
          message: getTranslation(defaultLocale).validators.userImage[error.code],
        });
      }
      throw error;
    }
  }

  return betterAuth({
    appName,
    secret,
    baseURL,
    trustedOrigins: async () => resolveAuthTrustedOrigins(trustedOriginsSources),
    database: drizzleAdapter(config.db, {
      provider: "pg",
      schema: {
        user,
        account,
        session,
        verification,
      },
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (userRecord) => ({
            data: {
              ...userRecord,
              image:
                userRecord.image == null
                  ? userRecord.image
                  : normalizePersistedUserImage(userRecord.image),
            },
          }),
        },
        update: {
          before: async (userRecord) => {
            if (!("image" in userRecord)) {
              return { data: userRecord };
            }
            return {
              data: {
                ...userRecord,
                image:
                  userRecord.image == null
                    ? userRecord.image
                    : normalizePersistedUserImage(userRecord.image),
              },
            };
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (nodeEnv !== "development") return;
        const returned = ctx.context.returned;
        const devData = (ctx.request as Request & { context?: Record<string, string> } | undefined)
          ?.context;
        if (!returned || !devData) return;

        const dev: Record<string, string> = {};
        if (devData.verificationUrl) {
          dev.verificationUrl = devData.verificationUrl;
          dev.message = "Development mode: Use this verification URL instead of checking email";
        }
        if (devData.resetUrl) {
          dev.resetUrl = devData.resetUrl;
          dev.message = "Development mode: Use this reset URL instead of checking email";
        }
        if (Object.keys(dev).length === 0) return;
        return ctx.json({ ...(returned as object), dev });
      }),
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification,
      sendResetPassword: async ({ user: authUser, url }, request) => {
        const { locale } = getRefererInfo(request);
        attachDevContext(request, "resetUrl", url, nodeEnv);

        const emailResult = await config.email.sendResetPasswordEmail(authUser.email, {
          name: authUser.name || authUser.email.split("@")[0] || "user",
          resetUrl: url,
          expiryHours: emailExpiryHours,
          appName,
          locale,
        });

        if (!emailResult.success) {
          const t = getTranslation(locale as SupportedLocale);
          throw new APIError("INTERNAL_SERVER_ERROR", {
            code: "EMAIL_SEND_FAILED",
            message: t.auth.authErrors.EMAIL_SEND_FAILED,
          });
        }
      },
    },
    emailVerification: {
      sendOnSignUp: requireEmailVerification,
      sendVerificationEmail: async ({ user: authUser, url }, request) => {
        const { locale, lastSegment } = getRefererInfo(request);
        const isUserInitiated = request?.headers?.get("x-resend-source") === "user-initiated";

        // better-auth may auto-trigger verification on sign-in when the
        // account is unverified; skip unless the user explicitly resends.
        if (lastSegment === "signin" && !isUserInitiated) {
          return;
        }

        attachDevContext(request, "verificationUrl", url, nodeEnv);

        const emailResult = await config.email.sendVerificationEmail(authUser.email, {
          name: authUser.name || authUser.email.split("@")[0] || "user",
          verificationUrl: url,
          expiryHours: emailExpiryHours,
          appName,
          locale,
        });

        if (!emailResult.success) {
          const t = getTranslation(locale as SupportedLocale);
          throw new APIError("INTERNAL_SERVER_ERROR", {
            code: "EMAIL_SEND_FAILED",
            message: t.auth.authErrors.EMAIL_SEND_FAILED,
          });
        }
      },
      autoSignInAfterVerification: true,
    },
    socialProviders,
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "github"],
      },
    },
    session: {
      // Every session is re-read server side (the Feishu mode also checks its
      // `feishu_login_sessions` row, FSL-126). A signed cookie cache would keep a
      // removed session usable until it expires, so keep it disabled for every mode.
      // FSL-133: the session declares no additional (enterprise) field.
      cookieCache: {
        enabled: false,
      },
    },
    plugins: [
      // FSL-127: first, so its `onRequest` and `before` hook run ahead of every other plugin's.
      ...(config.feishuLogin ? [createFeishuLoginOperationPolicy()] : []),
      admin({
        adminRoles: ["admin"],
      }),
      ...(config.feishuLogin ? [feishuLogin(config.feishuLogin)] : []),
    ],
    rateLimit: {
      enabled: nodeEnv === "production",
      customRules: {
        "/send-verification-email": {
          window: 60,
          max: 1,
        },
        "/request-password-reset": {
          window: 60,
          max: 1,
        },
        ...(config.feishuLogin ? { [FEISHU_LOGIN_REQUEST_PATH]: feishuLoginRequestRateLimitRule } : {}),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export { toNextJsHandler } from "better-auth/next-js";
