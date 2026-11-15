// megaui-only (FS-93): one complete Web assembly per JS realm, across Next bundles.
import { createHash } from "node:crypto";
import {
  createEnterpriseOtpConsumer,
  createEnterpriseOtpCrypto,
  type Auth,
  type EnterpriseOtpVerifyPort,
  type EnterpriseSessionAuthority,
} from "@megaui/auth";
import { resolveEnterpriseConfig, resolveEffectiveAuthMode, type EffectiveAuthMode } from "@megaui/core";
import { assertEnterpriseScope, createDatabaseClient, type DatabaseClient } from "@megaui/database";
import {
  createEnterpriseEligibilityService,
  createEnterprisePairingService,
  createPostgresAuthenticationEligibilityReader,
  type EnterprisePairingService,
  type EnterprisePairingRequest,
} from "@megaui/engine";
import { readEnterpriseWebConfig, requiresEnterpriseWebRuntime, type EnterpriseWebConfig } from "./enterprise-config";
import { resolveEnterpriseTransport, type EnterprisePairingTransport } from "./enterprise-transport";

// The key must not contain the protocol: a new bundle must see and reject an old
// protocol instead of silently creating a second assembly under another key.
const REGISTRY = Symbol.for("megaui.web.enterprise-runtime");
const PROTOCOL = "fs93-web-v1";
type State = "initializing" | "ready" | "closing" | "closed" | "failed" | "cleanup-pending";
type ObservedClient = { once(event: "end", callback: () => void): unknown };
export type WebCloseResult = Readonly<{ kind: "closed" | "cleanup-pending" }>;
export type PrepareWebAuth = () => {
  fingerprint: string;
  create(db: DatabaseClient["db"], wiring?: {
    readonly pairingPort?: EnterprisePairingService;
    readonly resolveTransport?: (request: Request) => EnterprisePairingTransport | null;
    readonly verifyPort?: EnterpriseOtpVerifyPort;
    readonly qualifyEnterprise?: (authority: EnterpriseSessionAuthority) => Promise<boolean>;
  }): Auth;
};
export interface WebAssembly {
  readonly auth: Auth;
  readonly database: DatabaseClient;
  readonly mode: EnterpriseWebConfig["mode"];
  readonly effectiveModeAtStartup: EffectiveAuthMode;
  readonly scope: EnterpriseWebConfig["scope"];
  readonly origin: string | undefined;
  readonly pairing: Readonly<{ kind: "disabled" }> | Readonly<{ kind: "enabled"; service: EnterprisePairingService }>;
}
interface Registry {
  protocol: string;
  state: State;
  fingerprint?: string;
  initialization?: Promise<WebAssembly>;
  work?: Promise<WebAssembly>;
  assembly?: WebAssembly;
  database?: DatabaseClient;
  cleanup?: Promise<WebCloseResult>;
  cleanupWork?: Promise<void>;
  endResponsibilities: Set<Promise<void>>;
  failed: boolean;
  prepareAuth?: PrepareWebAuth;
}

const unavailable = () => new Error("ENTERPRISE_WEB_UNAVAILABLE");
function registry(): Registry | undefined {
  const entry = Reflect.get(globalThis, REGISTRY) as Registry | undefined;
  if (entry && entry.protocol !== PROTOCOL) throw unavailable();
  return entry;
}
function newRegistry(state: State): Registry {
  const entry: Registry = { protocol: PROTOCOL, state, endResponsibilities: new Set(), failed: false };
  Reflect.set(globalThis, REGISTRY, entry);
  return entry;
}
function inputs(prepareAuth: PrepareWebAuth) {
  const config = readEnterpriseWebConfig();
  const auth = prepareAuth();
  const fingerprint = createHash("sha256").update(config.snapshot).update(auth.fingerprint).digest("hex");
  return { config, auth, fingerprint };
}
function compatible(entry: Registry, fingerprint: string): void {
  if (entry.fingerprint !== fingerprint) {
    entry.failed = true;
    void close(entry);
    throw unavailable();
  }
}
function checkConfiguration(entry: Registry, prepareAuth = entry.prepareAuth): void {
  try {
    if (!prepareAuth) throw unavailable();
    compatible(entry, inputs(prepareAuth).fingerprint);
  }
  catch { entry.failed = true; void close(entry); throw unavailable(); }
}
function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(unavailable()), milliseconds);
    work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(unavailable()); });
  });
}

/** Observe only public release/remove/end events; no acquisition hooks or Pool interception. */
function trackConnectionEnds(entry: Registry, database: DatabaseClient) {
  const observed = new WeakMap<ObservedClient, () => void>();
  const observe = (client: ObservedClient) => {
    if (observed.has(client)) return;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const done = () => { entry.endResponsibilities.delete(pending); finish(); };
    observed.set(client, done);
    entry.endResponsibilities.add(pending);
    client.once("end", done);
  };
  database.pool.on("release", (_error: unknown, client: ObservedClient) => observe(client));
  // pg emits remove in its Client.end callback, after the underlying connection
  // ended. This also resolves a release observed after an earlier error/end.
  database.pool.on("remove", (client: ObservedClient) => { observed.get(client)?.(); });
  return observe;
}

async function preflight(entry: Registry, config: Readonly<EnterpriseWebConfig>, observe: (client: ObservedClient) => void): Promise<EffectiveAuthMode> {
  const client = await entry.database!.pool.connect();
  observe(client);
  let broken = false;
  try {
    if (entry.state !== "initializing") throw unavailable();
    if (!config.scope) {
      const rows = await client.query(`select 1 from enterprise_policy
        where activation_state is distinct from 'legacy' or auth_epoch is distinct from 0 limit 1`);
      if (rows.rows.length !== 0) throw unavailable();
      return "legacy";
    }
    // ACL functions must run as an actually selectable identity: asking about
    // an inherited SUPER role would include its non-inheritable superpowers.
    // Ownership and membership capabilities still need the full effective set.
    const result = await client.query<{
      scope: string; owner_fingerprint: string; deployment_role: string; environment: string;
      activation_state: string; auth_epoch: number; role_name: string; can_ddl: boolean; can_create_db: boolean; same_session: boolean;
    }>(`with set_actors as (
        select oid from pg_catalog.pg_roles
        where rolname=current_user or pg_catalog.pg_has_role(session_user,oid,'SET')
      ), actors as (
        select r.*, pg_catalog.pg_has_role(session_user,r.oid,'SET') as can_set
        from pg_catalog.pg_roles r
        where exists (select 1 from set_actors a where pg_catalog.pg_has_role(a.oid,r.oid,'USAGE'))
      ), powers as (
        select coalesce(bool_or(r.can_set and r.rolcreatedb),false) as can_create_db,
          coalesce(bool_or(
            (r.can_set and (r.rolsuper or r.rolcreaterole or r.rolreplication or r.rolbypassrls))
            or left(r.rolname,3)='pg_'
            or exists (select 1 from pg_catalog.pg_auth_members m where m.member=r.oid and m.admin_option)
            or (r.can_set and pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE'))
            or r.oid=(select datdba from pg_catalog.pg_database where datname=current_database())
            or exists (select 1 from pg_catalog.pg_namespace n
              where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
                and (n.nspowner=r.oid or (r.can_set and pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))))
            or exists (select 1 from pg_catalog.pg_shdepend d
              where d.dbid=(select oid from pg_catalog.pg_database where datname=current_database())
                and d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid=r.oid and d.deptype='o')
          ),false) as can_ddl from actors r
      )
      select scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch,
        current_user as role_name, current_user=session_user as same_session, powers.*
      from enterprise_policy cross join powers where scope=$1 limit 2`, [config.scope.instanceId]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || row.deployment_role !== config.scope.environment
      || !Number.isSafeInteger(row.auth_epoch) || row.auth_epoch < 0
      || typeof row.role_name !== "string" || !row.role_name || row.same_session !== true
      || typeof row.can_ddl !== "boolean" || typeof row.can_create_db !== "boolean") throw unavailable();
    assertEnterpriseScope({ expectation: config.scope, marker: { scope: row.scope, ownerFingerprint: row.owner_fingerprint,
      environment: row.environment, activationState: row.activation_state, authEpoch: row.auth_epoch },
      privileges: { roleName: row.role_name, canDdl: row.can_ddl, canCreateDatabase: row.can_create_db } });
    resolveEnterpriseConfig({ authMode: config.mode, activated: row.activation_state !== "legacy" || row.auth_epoch !== 0 });
    const effective = resolveEffectiveAuthMode(config.mode, row.activation_state);
    if (effective === "reject" || (row.activation_state === "legacy" && row.auth_epoch !== 0)) throw unavailable();
    return effective;
  } catch (error) {
    console.error("enterprise.web.preflight", error instanceof Error ? error.message : "failed");
    broken = true;
    throw unavailable();
  }
  finally { client.release(broken); }
}

function close(entry: Registry): Promise<WebCloseResult> {
  if (entry.cleanup) return entry.cleanup;
  // Seal admission synchronously, before scheduling or awaiting any cleanup.
  entry.state = "closing";
  const poolEnd = Promise.resolve().then(() => entry.database?.close());
  entry.cleanupWork = (async () => {
    // A failing initialization does not cancel the independent Pool cleanup.
    const outcomes = await Promise.allSettled([poolEnd, entry.work]);
    if (outcomes[0]?.status === "rejected") throw unavailable();
    await Promise.all([...entry.endResponsibilities]);
  })();
  entry.cleanup = deadline(entry.cleanupWork, 5_000).then(() => {
    entry.state = entry.failed ? "failed" : "closed";
    return Object.freeze({ kind: "closed" as const });
  }, () => {
    entry.state = "cleanup-pending";
    console.error("enterprise.web.cleanup-pending");
    return Object.freeze({ kind: "cleanup-pending" as const });
  });
  return entry.cleanup;
}

function createEnterpriseEligibility(
  config: Readonly<EnterpriseWebConfig>,
  pool: DatabaseClient["pool"],
): ReturnType<typeof createEnterpriseEligibilityService> | undefined {
  const pairing = config.pairing;
  const scope = config.scope;
  if (!scope || !pairing?.departmentIds) return undefined;
  return createEnterpriseEligibilityService({
    directoryScope: { tenantKey: pairing.tenantKey, appId: pairing.appId, departmentIds: pairing.departmentIds },
    policyScope: scope.instanceId,
    authMode: config.mode,
    databaseReader: createPostgresAuthenticationEligibilityReader(pool),
    directoryReader: {
      tenantKey: pairing.tenantKey,
      appId: pairing.appId,
      read: async () => { throw new Error("ENTERPRISE_DIRECTORY_READER_UNAVAILABLE"); },
    },
  });
}

function createEnterpriseVerifyPort(
  config: Readonly<EnterpriseWebConfig>,
  pool: DatabaseClient["pool"],
): EnterpriseOtpVerifyPort | undefined {
  const pairing = config.pairing;
  const scope = config.scope;
  const eligibility = createEnterpriseEligibility(config, pool);
  if (!scope || !pairing?.otp || !eligibility) return undefined;
  const crypto = createEnterpriseOtpCrypto({
    hmacKeyId: "enterprise-otp-v1",
    hmacKey: pairing.otp.hmacKey,
    deliveryKeyId: "enterprise-delivery-v1",
    deliveryKey: pairing.otp.deliveryKey,
  });
  const consumer = createEnterpriseOtpConsumer({
    pool,
    scope: scope.instanceId,
    deploymentRole: scope.environment as "development" | "test" | "canary" | "production",
    tenantKey: pairing.tenantKey,
    appId: pairing.appId,
    crypto,
    qualify: input => eligibility.authenticationEligibility(input.localUserId, input.identityId, input.authEpoch),
  });
  return input => consumer.consume(input);
}

/** Called by Next's awaited public Node instrumentation, never at module import. */
export function initializeWebAssembly(prepareAuth: PrepareWebAuth): Promise<WebAssembly> {
  let entry: Registry | undefined;
  try {
    entry = registry();
    if (entry) {
      if (entry.state !== "initializing" && entry.state !== "ready") throw unavailable();
      checkConfiguration(entry, prepareAuth);
      return entry.initialization!;
    }
    entry = newRegistry("initializing");
    entry.prepareAuth = prepareAuth;
    const { config, auth, fingerprint } = inputs(prepareAuth);
    entry.fingerprint = fingerprint;
    entry.database = createDatabaseClient({ connectionString: config.connectionString, max: 10,
      connectionTimeoutMillis: 1000, statementTimeoutMillis: 3000,
      onPoolError: () => { console.error("enterprise.web.pool-error"); } });
    const current = entry;
    const observe = trackConnectionEnds(current, current.database!);
    current.work = (async (): Promise<WebAssembly> => {
      const effective = await preflight(current, config, observe);
      if (current.state !== "initializing") throw unavailable();
      checkConfiguration(current);
      let pairing: WebAssembly["pairing"] = Object.freeze({ kind: "disabled" });
      if (config.pairing) {
        const service = createEnterprisePairingService({ pool: current.database!.pool, expectation: config.scope!,
          tenantKey: config.pairing.tenantKey, appId: config.pairing.appId, proxyCidrs: config.pairing.proxyCidrs,
          ipHmacMaster: Buffer.from(config.pairing.ipMaster, "base64url"),
          alert: () => { console.error("enterprise.web.pairing-budget-saturated"); } });
        pairing = Object.freeze({ kind: "enabled", service: Object.freeze({ request: (input: EnterprisePairingRequest) => {
          if (current.state !== "ready") return Promise.resolve({ kind: "unavailable" as const });
          try { checkConfiguration(current); } catch { return Promise.resolve({ kind: "unavailable" as const }); }
          return service.request(input);
        } }) });
      }
      const eligibility = createEnterpriseEligibility(config, current.database!.pool);
      const authInstance = auth.create(current.database!.db, {
        pairingPort: pairing.kind === "enabled" ? pairing.service : undefined,
        resolveTransport: resolveEnterpriseTransport,
        verifyPort: createEnterpriseVerifyPort(config, current.database!.pool),
        qualifyEnterprise: eligibility
          ? (authority) => eligibility.authenticationEligibility(authority.localUserId, authority.identityId, authority.authEpoch)
          : async () => false,
      });
      await authInstance.$context;
      if (current.state !== "initializing") throw unavailable();
      checkConfiguration(current);
      return Object.freeze({ auth: authInstance, database: current.database!, mode: config.mode,
        effectiveModeAtStartup: effective, scope: config.scope, origin: config.origin, pairing });
    })();
    current.initialization = deadline(current.work, 10_000).then(assembly => {
      if (current.state !== "initializing") throw unavailable();
      current.assembly = assembly;
      current.state = "ready";
      return assembly;
    }).catch(() => {
      current.failed = true;
      void close(current);
      throw unavailable();
    });
    return current.initialization;
  } catch (error) {
    console.error("enterprise.web.init", error instanceof Error ? error.message : "failed");
    if (entry && !entry.initialization) { entry.failed = true; void close(entry); }
    return Promise.reject(unavailable());
  }
}

/** Undefined only for independent, unscoped legacy consumers before any registry exists. */
export function getReadyWebAssembly(prepareAuth?: PrepareWebAuth): WebAssembly | undefined {
  const entry = registry();
  if (!entry) {
    if (requiresEnterpriseWebRuntime()) throw unavailable();
    return undefined;
  }
  if (entry.state !== "ready" || !entry.assembly) throw unavailable();
  checkConfiguration(entry, prepareAuth);
  return entry.assembly;
}

export function closeEnterpriseWebRuntime(): Promise<WebCloseResult> {
  return close(registry() ?? newRegistry("closed"));
}
