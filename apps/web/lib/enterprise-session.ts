// megaui-only (FS-15): one protected Web actor resolver for pages and BFF.
//
// Better Auth's public session projection deliberately hides the enterprise
// grant fields. The resolver therefore treats the verified session id as the
// only input from the request, reloads the server-side enterprise metadata,
// and delegates the final qualification predicate to the shared engine port.
import type { Auth } from "@megaui/auth";
import {
  createEnterpriseEligibilityService,
  createPostgresAuthenticationEligibilityReader,
  type EligibilitySqlClient,
  type EnterpriseEligibilityService,
} from "@megaui/engine";

import { getAuth, prepareWebAuth, resolveCurrentWebAuthMode } from "./auth";
import { readEnterpriseWebConfig } from "./enterprise-config";
import { getReadyWebAssembly, type WebAssembly } from "./enterprise-runtime";

export interface WebSessionSnapshot {
  readonly user: Readonly<{ id: string; email?: string | null }>;
  readonly session: Readonly<{ id: string }>;
}

export interface EnterpriseSessionAuthority {
  readonly localUserId: string;
  readonly identityId: string;
  readonly tenantKey: string;
  readonly appId: string;
  readonly authEpoch: number;
  readonly authMethod: string;
  readonly enterpriseGrantId: string;
  readonly backendUsername: string;
  readonly notificationEmail?: string | null;
}

export interface WebActor {
  readonly kind: "legacy" | "enterprise";
  readonly userId: string;
  readonly identityId?: string;
  readonly authEpoch?: number;
  readonly backendUsername?: string;
  readonly email?: string | null;
  readonly sessionId: string;
}

export interface WebActorResolverPorts {
  readonly mode: "legacy" | "enterprise" | "maintenance";
  readonly readSession: (headers: Headers) => Promise<WebSessionSnapshot | null>;
  readonly readEnterpriseAuthority?: (session: WebSessionSnapshot) => Promise<EnterpriseSessionAuthority | null>;
  readonly qualifyEnterprise?: (authority: EnterpriseSessionAuthority) => Promise<boolean>;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validSnapshot(value: WebSessionSnapshot | null): value is WebSessionSnapshot {
  return Boolean(value && validText(value.user?.id) && validText(value.session?.id));
}

/** Pure decision layer, intentionally straightforward to contract-test. */
export function createWebActorResolver(ports: WebActorResolverPorts) {
  return async (headers: Headers): Promise<WebActor | null> => {
    // Maintenance is a shared business-access gate, not a session variant.
    // Return before touching Better Auth or enterprise metadata so old cookies
    // and secondary stores cannot be treated as a recoverable principal.
    if (ports.mode !== "legacy" && ports.mode !== "enterprise") return null;
    let snapshot: WebSessionSnapshot | null;
    try {
      snapshot = await ports.readSession(headers);
    } catch {
      return null;
    }
    if (!validSnapshot(snapshot)) return null;
    if (ports.mode === "legacy") {
      return Object.freeze({
        kind: "legacy" as const,
        userId: snapshot.user.id,
        ...(snapshot.user.email !== undefined ? { email: snapshot.user.email } : {}),
        sessionId: snapshot.session.id,
      });
    }
    if (ports.mode !== "enterprise" || !ports.readEnterpriseAuthority || !ports.qualifyEnterprise) return null;
    let authority: EnterpriseSessionAuthority | null;
    try {
      authority = await ports.readEnterpriseAuthority(snapshot);
      if (!authority || !validText(authority.localUserId) || authority.localUserId !== snapshot.user.id
        || !validText(authority.identityId) || !validText(authority.tenantKey) || !validText(authority.appId)
        || !Number.isSafeInteger(authority.authEpoch) || authority.authEpoch < 0
        || authority.authMethod !== "enterprise" || !validText(authority.enterpriseGrantId)
        || !validText(authority.backendUsername)) return null;
      if (!(await ports.qualifyEnterprise(authority))) return null;
    } catch {
      return null;
    }
    return Object.freeze({
      kind: "enterprise" as const,
      userId: snapshot.user.id,
      identityId: authority.identityId,
      authEpoch: authority.authEpoch,
      backendUsername: authority.backendUsername,
      ...(authority.notificationEmail !== undefined
        ? { email: authority.notificationEmail }
        : snapshot.user.email !== undefined ? { email: snapshot.user.email } : {}),
      sessionId: snapshot.session.id,
    });
  };
}

type Pool = EligibilitySqlClient;

function readSessionSnapshot(auth: Auth, headers: Headers): Promise<WebSessionSnapshot | null> {
  return auth.api.getSession({
    headers,
    // The enterprise gate must never authorize from a stale signed cache.
    query: { disableCookieCache: true, disableRefresh: true },
  }).then(result => result ? {
    user: { id: result.user.id, email: result.user.email ?? null },
    session: { id: result.session.id },
  } : null);
}

async function readEnterpriseAuthority(pool: Pool, session: WebSessionSnapshot): Promise<EnterpriseSessionAuthority | null> {
  const result = await pool.query(
    `select current_session.user_id as "localUserId",
            current_session.enterprise_identity_id as "identityId",
            identity.tenant_key as "tenantKey",
            identity.app_id as "appId",
            current_session.auth_epoch as "authEpoch",
            current_session.auth_method as "authMethod",
            current_session.enterprise_grant_id as "enterpriseGrantId",
            profile.backend_username as "backendUsername",
            profile.notification_email as "notificationEmail"
       from "session" as current_session
       join enterprise_identity as identity on identity.id = current_session.enterprise_identity_id
       join enterprise_profile as profile on profile.user_id = current_session.user_id
      where current_session.id = $1
        and current_session.user_id = $2
        and profile.tenant_key = identity.tenant_key
        and current_session.expires_at > now()
      limit 2`,
    [session.session.id, session.user.id],
  );
  if (result.rows.length !== 1) return null;
  return result.rows[0] as EnterpriseSessionAuthority;
}

export function eligibilityForAssembly(config: ReturnType<typeof readEnterpriseWebConfig>, assembly: WebAssembly): EnterpriseEligibilityService | undefined {
  const pairing = config.pairing;
  const scope = config.scope;
  if (config.mode !== "enterprise" || !scope || !pairing?.departmentIds) return undefined;
  return createEnterpriseEligibilityService({
    directoryScope: { tenantKey: pairing.tenantKey, appId: pairing.appId, departmentIds: pairing.departmentIds },
    policyScope: scope.instanceId,
    authMode: config.mode,
    databaseReader: createPostgresAuthenticationEligibilityReader(assembly.database.pool),
    directoryReader: {
      tenantKey: pairing.tenantKey,
      appId: pairing.appId,
      read: async () => { throw new Error("ENTERPRISE_DIRECTORY_READER_UNAVAILABLE"); },
    },
  });
}

/** Server-to-server qualification for the exact internal introspection path. */
export async function resolveEnterpriseEligibility(input: {
  readonly localUserId: string;
  readonly identityId: string;
  readonly authEpoch: number;
}): Promise<boolean | null> {
  try {
    const config = readEnterpriseWebConfig();
    if (config.mode !== "enterprise") return null;
    const assembly = getReadyWebAssembly(prepareWebAuth);
    const eligibility = assembly && eligibilityForAssembly(config, assembly);
    if (!eligibility) return null;
    return await eligibility.authenticationEligibility(
      input.localUserId,
      input.identityId,
      input.authEpoch,
    );
  } catch {
    return null;
  }
}

/** Resolve a request into a qualified actor, or null for every failure. */
export async function resolveWebActor(headers: Headers): Promise<WebActor | null> {
  try {
    const config = readEnterpriseWebConfig();
    // An unscoped legacy deployment has no persistent enterprise authority and
    // retains the historical Better Auth path.  Once a scope is declared,
    // every request must use the ready enterprise assembly and its persisted
    // mode, even when AUTH_MODE is changed back to legacy.
    if (config.mode === "legacy" && !config.scope) {
      return createWebActorResolver({ mode: "legacy", readSession: input => readSessionSnapshot(getAuth(), input) })(headers);
    }
    const assembly = getReadyWebAssembly(prepareWebAuth);
    if (!assembly) return null;
    const currentMode = await resolveCurrentWebAuthMode(assembly.database.db);
    if (currentMode === "maintenance" || currentMode === "reject") return null;
    if (currentMode === "legacy") {
      return createWebActorResolver({
        mode: "legacy",
        readSession: input => readSessionSnapshot(assembly.auth, input),
      })(headers);
    }
    const eligibility = eligibilityForAssembly(config, assembly);
    if (!eligibility) return null;
    return createWebActorResolver({
      mode: config.mode,
      readSession: input => readSessionSnapshot(assembly.auth, input),
      readEnterpriseAuthority: session => readEnterpriseAuthority(assembly.database.pool, session),
      qualifyEnterprise: authority => eligibility.authenticationEligibility(authority.localUserId, authority.identityId, authority.authEpoch),
    })(headers);
  } catch {
    return null;
  }
}
