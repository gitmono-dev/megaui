// megaui-only (FS-37): read-only migration preview and caller-owned source reads.
import { Pool, type PoolClient } from "pg";
import { assertEnterpriseScope, readSqlRolePrivileges, targetFingerprint, EnterpriseScopeError,
  type EnterpriseScopeExpectation, type EnterpriseTargetMarker } from "@megaui/database";
import { deriveHistoricalActor, readActorInventoryState, inspectActorReservationCoverage,
  type ActorInventoryState } from "./actor-reservations";
import { compatibilityEmail } from "./identity-key";
import { parseMigrationManifest, migrationUserVersion, migrationIdentityDigest, migrationProfileDigest,
  buildMigrationEnvelope, migrationManifestDigest, MigrationInputError, MigrationSourceError,
  type MigrationAuthority, type MigrationMember, type MigrationUserSource, type MigrationIdentitySource,
  type MigrationProfileSource, type MigrationEnvelopeMember } from "./manifest";

export class MigrationPreviewError extends Error {
  constructor(readonly exitCode: 2 | 3 | 4, key: string) { super(key); this.name = "MigrationPreviewError"; }
}
export interface MigrationSources {
  users: MigrationUserSource[];
  identities: MigrationIdentitySource[];
  profiles: MigrationProfileSource[];
  actorState: ActorInventoryState;
}

// PostgreSQL must format the original timestamp: a pg Date would discard microseconds.
function timestampSql(column: string): string {
  return `case when isfinite(${column}) and extract(year from ${column}) between 1 and 9999 ` +
    `then to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') else null end`;
}

/** Shared exact user fingerprints, without authority guesses or transaction ownership. */
export async function readMigrationUserSources(client: PoolClient, localUserIds: readonly string[]): Promise<MigrationUserSource[]> {
  const users = new Map<string, MigrationUserSource>();
  for (let offset = 0; offset < localUserIds.length; offset += 100) {
    const ids = localUserIds.slice(offset, offset + 100);
    const rows = await client.query<MigrationUserSource>('select id,name,email,email_verified as "emailVerified",banned,' +
      timestampSql("updated_at") + ' as "updatedAt" from "user" where id=any($1::text[])', [ids]);
    for (const row of rows.rows) { migrationUserVersion(row); users.set(row.id, row); }
  }
  return [...users.values()];
}

/** No transaction/pool ownership or expected-version comparison: FS-61 reuses this inside its locked writer. */
export async function readMigrationSources(
  client: PoolClient, members: readonly MigrationMember[], scope: string, authority: MigrationAuthority,
): Promise<MigrationSources> {
  const users = new Map<string, MigrationUserSource>(), identities = new Map<string, MigrationIdentitySource>();
  const profiles = new Map<string, MigrationProfileSource>();
  const actorState = await readActorInventoryState(client, scope);
  for (let offset = 0; offset < members.length; offset += 100) {
    const chunk = members.slice(offset, offset + 100), ids = chunk.map(row => row.local_user_id);
    for (const row of await readMigrationUserSources(client, ids)) users.set(row.id, row);
    const identityRows = await client.query<MigrationIdentitySource>(
      "select id,local_user_id,tenant_key,app_id,open_id,union_id,status,identity_version," +
      timestampSql("created_at") + " as created_at," + timestampSql("updated_at") + " as updated_at " +
      "from enterprise_identity where local_user_id=any($1::text[]) or " +
      "(tenant_key=$2 and app_id=$3 and open_id=any($4::text[]))",
      [ids, authority.tenantKey, authority.appId, chunk.map(row => row.open_id)]);
    migrationIdentityDigest(identityRows.rows);
    for (const row of identityRows.rows) identities.set(row.id, row);
    const profileRows = await client.query<MigrationProfileSource>(
      "select user_id,tenant_key,login_name,backend_username,display_name,notification_email," +
      timestampSql("created_at") + " as created_at," + timestampSql("updated_at") + " as updated_at " +
      "from enterprise_profile where user_id=any($1::text[]) or (tenant_key=$2 and login_name=any($3::text[]))",
      [ids, authority.tenantKey, chunk.map(row => row.login_name)]);
    for (const row of profileRows.rows) { migrationProfileDigest(row); profiles.set(row.user_id, row); }
  }
  return { users: [...users.values()], identities: [...identities.values()], profiles: [...profiles.values()], actorState };
}

export type MigrationConflict = "USER_MISSING" | "USER_VERSION_MISMATCH" | "IDENTITY_VERSION_MISMATCH" |
  "IDENTITY_SCOPE_MISMATCH" | "PROFILE_SCOPE_MISMATCH" | "IDENTITY_BINDING_MISMATCH" | "PROFILE_ALIAS_MISMATCH" |
  "EXTERNAL_IDENTITY_OCCUPIED" | "ALIAS_OCCUPIED" | "IDENTITY_INACTIVE" | "QUARANTINED" |
  "ACTOR_MISSING" | "ACTOR_UNAVAILABLE" | "COMPATIBILITY_EMAIL_CONFLICT";
export interface MigrationPreviewReport {
  schemaVersion: 1;
  targetFingerprint: string;
  policyEpoch: number;
  status: "ready" | "conflict";
  counts: { total: number; ready: number; conflicts: number };
  manifestDigest: string | null;
  rows: { row: number; status: "ready" | "conflict"; conflictKeys: MigrationConflict[] }[];
}

export function evaluateRows(members: readonly MigrationMember[], sources: MigrationSources, authority: MigrationAuthority) {
  const users = new Map(sources.users.map(row => [row.id, row]));
  const profiles = new Map(sources.profiles.map(row => [row.user_id, row]));
  const aliases = new Map(sources.profiles.filter(row => row.tenant_key === authority.tenantKey).map(row => [row.login_name, row.user_id]));
  const identities = new Map<string, MigrationIdentitySource[]>(), externals = new Map<string, string>();
  for (const identity of sources.identities) {
    const group = identities.get(identity.local_user_id) ?? []; group.push(identity); identities.set(identity.local_user_id, group);
    if (identity.tenant_key === authority.tenantKey && identity.app_id === authority.appId) externals.set(identity.open_id, identity.local_user_id);
  }
  const subjects = new Map(sources.actorState.subjects.map(row => [row.id, row]));
  const emails = new Map(sources.actorState.subjects.map(row => [row.email, row.id]));
  const reservations = new Map(sources.actorState.rows.map(row => [row.actor, row]));
  const envelopeMembers: MigrationEnvelopeMember[] = [];
  const rows: MigrationPreviewReport["rows"] = members.map((member, index) => {
    const conflicts = new Set<MigrationConflict>();
    const user = users.get(member.local_user_id), profile = profiles.get(member.local_user_id);
    const bindings = identities.get(member.local_user_id) ?? [];
    const binding = bindings.find(row => row.tenant_key === authority.tenantKey && row.app_id === authority.appId);
    if (bindings.some(row => row.tenant_key !== authority.tenantKey || row.app_id !== authority.appId)) conflicts.add("IDENTITY_SCOPE_MISMATCH");
    if (profile && profile.tenant_key !== authority.tenantKey) conflicts.add("PROFILE_SCOPE_MISMATCH");
    if ((binding?.identity_version ?? 0) !== member.expected_identity_version) conflicts.add("IDENTITY_VERSION_MISMATCH");
    if (binding && binding.open_id !== member.open_id) conflicts.add("IDENTITY_BINDING_MISMATCH");
    if (profile && profile.login_name !== member.login_name) conflicts.add("PROFILE_ALIAS_MISMATCH");
    if (bindings.some(row => row.status !== "active")) conflicts.add("IDENTITY_INACTIVE");
    const externalOwner = externals.get(member.open_id), aliasOwner = aliases.get(member.login_name);
    if (externalOwner && externalOwner !== member.local_user_id) conflicts.add("EXTERNAL_IDENTITY_OCCUPIED");
    if (aliasOwner && aliasOwner !== member.local_user_id) conflicts.add("ALIAS_OCCUPIED");
    if (!user) conflicts.add("USER_MISSING");
    else {
      const userVersion = migrationUserVersion(user);
      if (userVersion !== member.expected_user_version) conflicts.add("USER_VERSION_MISMATCH");
      const actor = deriveHistoricalActor({ name: user.name, email: user.email, frozenBackendUsername: profile?.backend_username });
      const reservation = actor === undefined ? undefined : reservations.get(actor);
      if (actor === undefined || !/\P{White_Space}/u.test(actor)) conflicts.add("ACTOR_MISSING");
      else if (!reservation || reservation.state !== "reserved" || reservation.localUserId !== user.id || reservation.quarantined) conflicts.add("ACTOR_UNAVAILABLE");
      if (subjects.get(user.id)?.quarantined) conflicts.add("QUARANTINED");
      const key = compatibilityEmail(user.id), emailOwner = emails.get(key);
      if ((emailOwner !== undefined && emailOwner !== user.id) ||
        (user.email.toLowerCase().endsWith("@identity.invalid") && (user.email !== key || !binding || !profile ||
          binding.open_id !== member.open_id || profile.tenant_key !== authority.tenantKey || profile.login_name !== member.login_name))) {
        conflicts.add("COMPATIBILITY_EMAIL_CONFLICT");
      }
      if (conflicts.size === 0 && actor !== undefined) envelopeMembers.push({ ...member, backend_username: actor,
        source_user_version: userVersion, source_identity_digest: migrationIdentityDigest(bindings),
        source_profile_digest: migrationProfileDigest(profile ?? null) });
    }
    return { row: index + 1, status: conflicts.size ? "conflict" : "ready", conflictKeys: [...conflicts].sort() };
  });
  return { rows, envelopeMembers };
}

// pg merges URL parameters after Pool options. Bound the effective client timeout in the URL itself.
function boundedConnectionString(value: string): string {
  try {
    const url = new URL(value);
    let budget = 5000;
    for (const supplied of url.searchParams.getAll("query_timeout")) {
      if (!/^\d+$/.test(supplied) || !Number.isSafeInteger(Number(supplied))) throw new Error("timeout");
      const milliseconds = Number(supplied);
      if (milliseconds > 0) budget = Math.min(budget, milliseconds);
    }
    url.searchParams.set("query_timeout", String(budget));
    return url.toString();
  } catch { throw new MigrationPreviewError(2, "INVALID_CONFIG"); }
}

/** Owns the single repeatable-read snapshot and closes every connection on success or rejection. */
export async function previewMigration(options: {
  bytes: Uint8Array; databaseUrl: string; expectation: EnterpriseScopeExpectation; authority: MigrationAuthority;
  deadline: number; now?: () => Date;
}): Promise<MigrationPreviewReport> {
  const members = parseMigrationManifest(options.bytes, options.authority);
  const remaining = () => Math.floor(options.deadline - performance.now());
  if (remaining() <= 0) throw new MigrationPreviewError(4, "DEPENDENCY_FAILED");
  const pool = new Pool({ connectionString: boundedConnectionString(options.databaseUrl), max: 1,
    application_name: "megaui-enterprise-preview", connectionTimeoutMillis: Math.min(5000, remaining()), query_timeout: 5000 });
  pool.on("error", () => {});
  let client: PoolClient | undefined, expired = false;
  const timer = setTimeout(() => { expired = true; client?.release(true); client = undefined; }, remaining());
  const checkBudget = () => { if (expired || remaining() <= 0) throw new MigrationPreviewError(4, "DEPENDENCY_FAILED"); };
  try {
    client = await pool.connect(); checkBudget();
    await client.query("begin isolation level repeatable read read only");
    // Tighten actual post-startup settings, including URL options and role defaults; retain shorter limits.
    await client.query("select set_config(name, least(coalesce(nullif(setting::int,0),5000),5000)::text,true) " +
      "from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout')");
    const policy = await client.query<EnterpriseTargetMarker & { deploymentRole: string }>(
      'select scope,owner_fingerprint as "ownerFingerprint",environment,activation_state as "activationState",' +
      'auth_epoch as "authEpoch",deployment_role as "deploymentRole" from enterprise_policy limit 2');
    const marker = policy.rows[0];
    if (policy.rows.length !== 1 || !marker || marker.deploymentRole !== options.expectation.environment ||
      !["legacy", "maintenance", "enterprise"].includes(marker.activationState) || !Number.isInteger(marker.authEpoch) || marker.authEpoch < 0 ||
      (marker.activationState === "legacy" && marker.authEpoch !== 0)) throw new MigrationPreviewError(3, "SCOPE_REJECTED");
    const privileges = await readSqlRolePrivileges(client as unknown as Pool);
    assertEnterpriseScope({ marker, expectation: options.expectation, privileges });
    const sources = await readMigrationSources(client, members, options.expectation.instanceId, options.authority);
    const coverage = inspectActorReservationCoverage(sources.actorState, { now: options.now?.() });
    if (!coverage.complete) throw new MigrationPreviewError(3, "ACTOR_INVENTORY_REJECTED");
    const { rows, envelopeMembers } = evaluateRows(members, sources, options.authority);
    const ready = envelopeMembers.length, fingerprint = targetFingerprint(options.expectation);
    const manifestDigest = ready === members.length ? migrationManifestDigest(buildMigrationEnvelope({
      targetFingerprint: fingerprint, ...options.authority, ownershipDigest: coverage.ownershipDigest, members: envelopeMembers,
    })) : null;
    if (!inspectActorReservationCoverage(sources.actorState, { now: options.now?.() }).complete) {
      throw new MigrationPreviewError(3, "ACTOR_INVENTORY_REJECTED");
    }
    checkBudget(); await client.query("rollback"); checkBudget();
    return { schemaVersion: 1, targetFingerprint: fingerprint, policyEpoch: marker.authEpoch,
      status: ready === members.length ? "ready" : "conflict", counts: { total: members.length, ready, conflicts: members.length - ready },
      manifestDigest, rows };
  } catch (error) {
    if (error instanceof MigrationPreviewError || error instanceof MigrationInputError) throw error;
    if (error instanceof EnterpriseScopeError) throw new MigrationPreviewError(3, "SCOPE_REJECTED");
    if (error instanceof MigrationSourceError) throw new MigrationPreviewError(3, "SOURCE_REJECTED");
    throw new MigrationPreviewError(4, "DEPENDENCY_FAILED");
  } finally { clearTimeout(timer); client?.release(true); await pool.end(); }
}
