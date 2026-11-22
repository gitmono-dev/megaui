import { createHash } from "node:crypto";
import {
  createAuth,
  generateEnterpriseOtpCode,
  resolveSocialProvidersFromEnv,
  type Auth,
} from "@megaui/auth";
import { resolveAuthMode } from "@megaui/core";
import { getDb, getPool, type Database } from "@megaui/database";
import { createEmailSender } from "@megaui/email";
import {
  createFeishuLoginIssuer,
  startFeishuLoginCleanup,
  type FeishuLoginReservation,
  type StopFeishuLoginCleanup,
} from "@megaui/engine";

import { resolveAuthMailRuntime } from "./email-runtime";
import { getRuntimeSecrets } from "./env";
import { readFeishuLoginConfig } from "./feishu-login-config";

// megaui-only (WA-01): app-local better-auth singleton via PK-06 `createAuth`.
// FSL-132: only two constructions remain, legacy (email and password, social
// providers) and Feishu (FSL-150). The old enterprise runtime, pairing, operation
// policy and session projection are gone.

let authSingleton: { readonly fingerprint: string; readonly auth: Auth } | null = null;

/**
 * FSL-150: whether this Web process runs the Feishu email-code login, decided by
 * `resolveAuthMode` (FSL-116): `AUTH_MODE=enterprise` with `AUTH_PROVIDER=feishu`.
 * For any pair `resolveAuthMode` refuses the answer is `false`; startup itself
 * refuses such a pair (`assertWebAuthMode`, FSL-132).
 */
export function isFeishuWebMode(source: NodeJS.Dict<string> = process.env): boolean {
  try {
    const resolved = resolveAuthMode({ AUTH_MODE: source.AUTH_MODE, AUTH_PROVIDER: source.AUTH_PROVIDER });
    return resolved.mode === "enterprise" && resolved.provider === "feishu";
  } catch {
    return false;
  }
}

/** The Feishu login logs carry stable keys only (never an email, a code, an open_id or a token). */
function logFeishuLoginKey(key: string): void {
  console.warn(key);
}

export interface FeishuWebAuthOptions {
  /**
   * Overrides the `NODE_ENV` that decides Better Auth's rate limit (enabled only for
   * `production`); the Feishu configuration, including its provider selection, still
   * reads `process.env`. Tests use it to build the production limit around the Mock.
   */
  readonly nodeEnv?: string;
}

/**
 * FSL-150: the Feishu-mode Better Auth instance. The issue service (FSL-122, FSL-154) is built
 * from `readFeishuLoginConfig` (FSL-121, FSL-148; `INVALID_FEISHU_LOGIN_CONFIG` fails closed)
 * with the `@megaui/auth` code generator, and handed to the `feishuLogin` plugin as its
 * `reserve` / `deliver` ports together with the verify options (pool, app ID, key). Passing
 * `feishuLogin` also registers the Feishu-mode operation allowlist (FSL-127); no enterprise
 * option (pairing, operation policy, session projection) and no social provider is passed.
 */
export function createFeishuWebAuth(options: FeishuWebAuthOptions = {}): Auth {
  const secrets = getRuntimeSecrets();
  const config = readFeishuLoginConfig(process.env);
  const { defaultFrom, provider } = resolveAuthMailRuntime();
  const pool = getPool();
  const issuer = createFeishuLoginIssuer({
    pool,
    appId: config.appId,
    appSecret: config.appSecret,
    otpHmacKey: config.otpHmacKey,
    trustedSiteUrl: secrets.betterAuthUrl,
    target: config.target,
    generateCode: generateEnterpriseOtpCode,
  });
  return createAuth({
    appName: secrets.appName,
    secret: secrets.betterAuthSecret,
    baseURL: secrets.betterAuthUrl,
    db: getDb(),
    email: createEmailSender({ defaultFrom, provider }),
    trustedOrigins: {
      appBaseUrl: secrets.appBaseUrl,
      betterAuthUrl: secrets.betterAuthUrl,
      trustedOriginsCsv: secrets.trustedOrigins,
    },
    allowedImagePublicUrlBase: secrets.s3PublicUrl,
    ...(options.nodeEnv === undefined ? {} : { nodeEnv: options.nodeEnv }),
    feishuLogin: {
      issue: {
        reserve: input => issuer.reserveFeishuLoginCode(input),
        // The plugin hands back, unread, exactly what `reserve` resolved.
        deliver: reservation => issuer.deliverFeishuLoginCode(reservation as FeishuLoginReservation),
      },
      log: logFeishuLoginKey,
      verify: { pool, appId: config.appId, otpHmacKey: config.otpHmacKey, log: logFeishuLoginKey },
    },
  });
}

let feishuAuthSingleton: { readonly fingerprint: string; readonly auth: Auth } | null = null;

/** The inputs of `createFeishuWebAuth`; a changed environment builds a new instance. */
function feishuWebAuthFingerprint(): string {
  const secrets = getRuntimeSecrets();
  const { defaultFrom, provider } = resolveAuthMailRuntime();
  const feishu = ["NODE_ENV", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "ENTERPRISE_OTP_HMAC_KEY", "FEISHU_PROVIDER",
    "FEISHU_SIMULATOR_ORIGIN"].map(key => process.env[key] ?? null);
  return createHash("sha256").update(JSON.stringify({ secrets, defaultFrom, provider, feishu })).digest("hex");
}

function getFeishuWebAuth(): Auth {
  const fingerprint = feishuWebAuthFingerprint();
  if (feishuAuthSingleton?.fingerprint === fingerprint) return feishuAuthSingleton.auth;
  const auth = createFeishuWebAuth();
  feishuAuthSingleton = { fingerprint, auth };
  return auth;
}

const FEISHU_CLEANUP = Symbol.for("megaui.web.feishu-login-cleanup");

/**
 * FSL-150: the Feishu-mode startup that `instrumentation.ts` `register()` awaits. It checks the
 * Feishu login configuration (fails closed with `INVALID_FEISHU_LOGIN_CONFIG`) and waits until
 * the first run of the code cleanup (FSL-146) has finished; later runs follow every 5 minutes on
 * an `unref()`ed timer. It builds no Auth instance and installs no signal handler. A second call
 * in the same JS realm waits for the first start instead of starting another schedule.
 */
export async function startFeishuWebRuntime(): Promise<void> {
  readFeishuLoginConfig(process.env);
  let started = Reflect.get(globalThis, FEISHU_CLEANUP) as Promise<StopFeishuLoginCleanup> | undefined;
  if (!started) {
    started = startFeishuLoginCleanup(getPool(), { log: key => { console.error(key); } });
    Reflect.set(globalThis, FEISHU_CLEANUP, started);
  }
  await started;
}

/** Stops the cleanup schedule of this JS realm, if one was started (tests). */
export async function stopFeishuWebRuntime(): Promise<void> {
  const started = Reflect.get(globalThis, FEISHU_CLEANUP) as Promise<StopFeishuLoginCleanup> | undefined;
  Reflect.deleteProperty(globalThis, FEISHU_CLEANUP);
  if (started) (await started)();
}

/**
 * FSL-132: the startup check of `instrumentation.ts`. It throws the `AuthModeError` of
 * `resolveAuthMode` for every pair it refuses, including `maintenance` and `enterprise`
 * without `AUTH_PROVIDER` (`INVALID_AUTH_PROVIDER`), so the Web refuses to start.
 */
export function assertWebAuthMode(source: NodeJS.Dict<string> = process.env): void {
  resolveAuthMode({ AUTH_MODE: source.AUTH_MODE, AUTH_PROVIDER: source.AUTH_PROVIDER });
}

/**
 * The legacy better-auth construction (PK-06 factory): email and password plus the
 * configured social providers. All inputs are captured synchronously; `create` builds
 * the sender and the Auth instance over the given database.
 * Auth-mail sender config is resolved only by `resolveAuthMailRuntime()`.
 */
export function prepareWebAuth() {
  const secrets = getRuntimeSecrets();
  const { defaultFrom, provider } = resolveAuthMailRuntime();
  const socialProviders = resolveSocialProvidersFromEnv();
  const fingerprint = createHash("sha256").update(JSON.stringify({ secrets, defaultFrom, provider,
    socialProviders, appNameInput: process.env.MEGAUI_APP_NAME ?? null })).digest("hex");
  return { fingerprint, create(db: Database): Auth {
    return createAuth({
      appName: secrets.appName,
      secret: secrets.betterAuthSecret,
      baseURL: secrets.betterAuthUrl,
      db,
      email: createEmailSender({ defaultFrom, provider }),
      socialProviders,
      trustedOrigins: {
        appBaseUrl: secrets.appBaseUrl,
        betterAuthUrl: secrets.betterAuthUrl,
        trustedOriginsCsv: secrets.trustedOrigins,
      },
      allowedImagePublicUrlBase: secrets.s3PublicUrl,
    });
  } };
}

/**
 * Lazily construct the better-auth instance of this process at request time.
 * Feishu mode builds the Feishu instance; every other accepted mode is legacy. A
 * changed environment builds a new legacy instance.
 */
export function getAuth(): Auth {
  if (isFeishuWebMode()) return getFeishuWebAuth();
  const prepared = prepareWebAuth();
  if (authSingleton?.fingerprint === prepared.fingerprint) return authSingleton.auth;
  const auth = prepared.create(getDb());
  authSingleton = { fingerprint: prepared.fingerprint, auth };
  return auth;
}
