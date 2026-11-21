import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createAuth,
  generateEnterpriseOtpCode,
  resolveSocialProvidersFromEnv,
  type Auth,
  type EnterpriseOperationMode,
  type EnterpriseSessionAuthority,
  type EnterpriseSessionPluginOptions,
} from "@megaui/auth";
import type { EnterprisePairingStatusPort, EnterpriseOtpVerifyPort } from "@megaui/auth";
import { resolveAuthMode, resolveEffectiveAuthMode, resolveEnterpriseConfig } from "@megaui/core";
import {
  enterpriseChallenges,
  enterpriseIdentity,
  enterprisePairings,
  enterprisePolicy,
  enterpriseProfile,
  getDb,
  getPool,
  session as authSession,
  type Database,
} from "@megaui/database";
import { createEmailSender } from "@megaui/email";
import {
  createFeishuLoginIssuer,
  startFeishuLoginCleanup,
  type EnterprisePairingService,
  type FeishuLoginReservation,
  type StopFeishuLoginCleanup,
} from "@megaui/engine";

import { resolveAuthMailRuntime } from "./email-runtime";
import { readEnterpriseWebConfig } from "./enterprise-config";
import { getRuntimeSecrets } from "./env";
import { getReadyWebAssembly, initializeWebAssembly } from "./enterprise-runtime";
import type { EnterprisePairingTransport } from "./enterprise-transport";
import { readFeishuLoginConfig } from "./feishu-login-config";

// megaui-only (WA-01): app-local better-auth singleton via PK-06 `createAuth`.
// `/api/auth/[...all]` handler lands in WA-02.

let authSingleton: Auth | null = null;

export interface WebAuthWiring {
  readonly pairingPort?: EnterprisePairingService;
  readonly resolveTransport?: (request: Request) => EnterprisePairingTransport | null;
  readonly verifyPort?: EnterpriseOtpVerifyPort;
  readonly qualifyEnterprise?: EnterpriseSessionPluginOptions["qualifyEnterprise"];
}

function createEnterpriseModeResolver(db: Database) {
  return async (): Promise<EnterpriseOperationMode> => {
      try {
        const config = readEnterpriseWebConfig();
        if (!config.scope) return "legacy";
        const rows = await db.select({ activationState: enterprisePolicy.activationState, authEpoch: enterprisePolicy.authEpoch })
          .from(enterprisePolicy)
          .where(eq(enterprisePolicy.scope, config.scope.instanceId))
          .limit(2);
        const row = rows.length === 1 ? rows[0] : undefined;
        if (!row || !Number.isSafeInteger(row.authEpoch) || row.authEpoch < 0) return "reject";
        resolveEnterpriseConfig({
          authMode: config.mode,
          activated: row.activationState !== "legacy" || row.authEpoch !== 0,
        });
        return resolveEffectiveAuthMode(config.mode, row.activationState);
      } catch {
        return "reject";
      }
    };
}

/**
 * Resolve the current persisted Web authentication mode for shared request
 * gates.  Scoped deployments must consult this on every business request so
 * changing AUTH_MODE back to legacy cannot restore access after activation.
 */
export function resolveCurrentWebAuthMode(db: Database): Promise<EnterpriseOperationMode> {
  return createEnterpriseModeResolver(db)();
}

function createEnterprisePublicProfileReader(db: Database) {
  return async (authority: EnterpriseSessionAuthority) => {
    try {
      const rows = await db.select({
        localUserId: enterpriseProfile.userId,
        displayName: enterpriseProfile.displayName,
        notificationEmail: enterpriseProfile.notificationEmail,
      }).from(enterpriseProfile).innerJoin(enterpriseIdentity, and(
        eq(enterpriseIdentity.id, authority.identityId),
        eq(enterpriseIdentity.localUserId, authority.localUserId),
        eq(enterpriseIdentity.tenantKey, enterpriseProfile.tenantKey),
      )).where(eq(enterpriseProfile.userId, authority.localUserId)).limit(2);
      return rows.length === 1 ? rows[0] ?? null : null;
    } catch {
      return null;
    }
  };
}

function createEnterpriseAuthorityReader(db: Database) {
  return async (lookup: { readonly sessionId: string; readonly userId: string }) => {
    try {
      const rows = await db.select({
        localUserId: authSession.userId,
        identityId: authSession.enterpriseIdentityId,
        authEpoch: authSession.authEpoch,
        authMethod: authSession.authMethod,
        enterpriseGrantId: authSession.enterpriseGrantId,
      }).from(authSession).where(and(
        eq(authSession.id, lookup.sessionId),
        eq(authSession.userId, lookup.userId),
      )).limit(2);
      const row = rows.length === 1 ? rows[0] : undefined;
      if (!row || !row.identityId || !row.enterpriseGrantId || !row.authMethod
        || row.authEpoch === null || !Number.isSafeInteger(row.authEpoch) || row.authEpoch < 0) return null;
      return {
        localUserId: row.localUserId,
        identityId: row.identityId,
        authEpoch: row.authEpoch,
        authMethod: row.authMethod,
        enterpriseGrantId: row.enterpriseGrantId,
      };
    } catch {
      return null;
    }
  };
}

/**
 * Read status only through the fixed Web deployment authority. The request
 * contributes a pairing id and a flow hash; tenant/app/scope/deployment are
 * never accepted from HTTP input.
 */
function createEnterprisePairingStatusPort(db: Database): EnterprisePairingStatusPort | undefined {
  const config = readEnterpriseWebConfig();
  if (config.mode !== "enterprise" || !config.scope || !config.pairing) return undefined;
  const scope = config.scope;
  const pairing = config.pairing;
  return async ({ pairingId, flowHash }) => {
    const rows = await db.select({
      state: enterprisePairings.state,
      expired: sql<boolean>`${enterprisePairings.expiresAt} <= now()`,
      challengeId: enterpriseChallenges.id,
    }).from(enterprisePairings).leftJoin(enterpriseChallenges, and(
      eq(enterpriseChallenges.pairingId, enterprisePairings.id),
      eq(enterpriseChallenges.scope, enterprisePairings.scope),
      eq(enterpriseChallenges.deploymentRole, enterprisePairings.deploymentRole),
      eq(enterpriseChallenges.flowHash, enterprisePairings.flowHash),
      eq(enterpriseChallenges.purpose, "login"),
    )).where(and(
      eq(enterprisePairings.id, pairingId),
      eq(enterprisePairings.scope, scope.instanceId),
      eq(enterprisePairings.deploymentRole, scope.environment),
      eq(enterprisePairings.tenantKey, pairing.tenantKey),
      eq(enterprisePairings.appId, pairing.appId),
      eq(enterprisePairings.flowHash, flowHash),
      eq(enterprisePairings.purpose, "login"),
    )).limit(1);
    const row = rows[0];
    if (!row) return { kind: "not-found" as const };
    if (row.state === "expired" || row.expired) return { kind: "expired" as const };
    if (row.state === "pending") return { kind: "pending" as const };
    if (row.state === "confirmed" && row.challengeId) return { kind: "confirmed" as const, challengeId: row.challengeId };
    return { kind: "unavailable" as const };
  };
}

/**
 * FSL-150: whether this Web process runs the Feishu email-code login, decided by
 * `resolveAuthMode` (FSL-116): `AUTH_MODE=enterprise` with `AUTH_PROVIDER=feishu`.
 * Without `AUTH_PROVIDER` (and for a pair `resolveAuthMode` refuses) the answer is
 * `false`, so every existing path keeps its current construction.
 */
export function isFeishuWebMode(source: NodeJS.Dict<string> = process.env): boolean {
  if ((source.AUTH_PROVIDER ?? "").trim() === "") return false;
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
 * Lazily construct the better-auth instance (PK-06 factory).
 * Middleware and the homepage call this at request time only.
 * Auth-mail sender config is resolved only by `resolveAuthMailRuntime()`.
 */
export function prepareWebAuth() {
  // Capture all inputs synchronously before runtime preflight can yield. The
  // sender and Auth are constructed only after the validated DB is supplied.
  const secrets = getRuntimeSecrets();
  const { defaultFrom, provider } = resolveAuthMailRuntime();
  const socialProviders = resolveSocialProvidersFromEnv();
  const fingerprint = createHash("sha256").update(JSON.stringify({ secrets, defaultFrom, provider,
    socialProviders, appNameInput: process.env.MEGAUI_APP_NAME ?? null })).digest("hex");
  return { fingerprint, create(db: Database, wiring: WebAuthWiring = {}): Auth {
    const email = createEmailSender({ defaultFrom, provider });
    const resolveMode = createEnterpriseModeResolver(db);
    return createAuth({
    appName: secrets.appName,
    secret: secrets.betterAuthSecret,
    baseURL: secrets.betterAuthUrl,
    db,
    email,
    socialProviders,
    trustedOrigins: {
      appBaseUrl: secrets.appBaseUrl,
      betterAuthUrl: secrets.betterAuthUrl,
      trustedOriginsCsv: secrets.trustedOrigins,
    },
    allowedImagePublicUrlBase: secrets.s3PublicUrl,
    enterprisePairing: wiring.pairingPort && wiring.resolveTransport ? {
      pairingPort: wiring.pairingPort.request,
      statusPort: createEnterprisePairingStatusPort(db),
      resolveTransport: wiring.resolveTransport,
      verifyPort: wiring.verifyPort,
    } : undefined,
    enterpriseOperationPolicy: { httpBasePath: "/api/auth", resolveMode },
    enterpriseSession: {
      resolveMode,
      readEnterpriseAuthority: createEnterpriseAuthorityReader(db),
      readEnterpriseProfile: createEnterprisePublicProfileReader(db),
      qualifyEnterprise: wiring.qualifyEnterprise ?? (async () => false),
    },
    });
  } };
}

export function getAuth(): Auth {
  // FSL-150: Feishu mode never consults the enterprise runtime registry.
  if (isFeishuWebMode()) return getFeishuWebAuth();
  // Check the process registry before the legacy singleton, including after a
  // failed/closed scoped runtime and after environment or bundle changes.
  const assembly = getReadyWebAssembly(prepareWebAuth);
  if (assembly) return assembly.auth;
  if (authSingleton) return authSingleton;
  const prepared = prepareWebAuth();
  authSingleton = prepared.create(getDb());
  return authSingleton;
}

/** Standard Next startup injects the sole Auth/mail assembler into the runtime. */
export function initializeEnterpriseWebRuntime() {
  return initializeWebAssembly(prepareWebAuth);
}
