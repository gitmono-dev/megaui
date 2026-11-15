// megaui-only (FS-10): unified enterprise eligibility has no upstream counterpart.
/**
 * FS-10：统一企业资格判定。
 *
 * The service factory binds every authority field. Directory admission performs
 * one provider-authoritative member read, while authentication eligibility uses
 * one PostgreSQL statement and never reaches the provider.
 */
import {
  isActiveLocalBan,
  isAuthenticationEligible,
  resolveEffectiveAuthMode,
  type AuthMode,
} from "@megaui/core";

import { DIRECTORY_FRESHNESS_LIMIT_MS } from "./directory-sync";
import {
  scopeHashOf,
  type AuthoritativeDirectoryMember,
  type DirectoryScope,
} from "./feishu/directory";

export interface DirectoryAdmissionReader {
  readonly tenantKey: string;
  readonly appId: string;
  read(openId: string): Promise<AuthoritativeDirectoryMember>;
}

export interface AuthenticationEligibilityLookup {
  identityId: string;
  localUserId: string;
  tenantKey: string;
  appId: string;
  policyScope: string;
  directoryScopeHash: string;
}

/** One statement-snapshot row of every authority used by authentication. */
export interface AuthenticationAuthorityRow {
  identityId: string;
  localUserId: string;
  tenantKey: string;
  appId: string;
  identityStatus: string;
  banned: boolean | null;
  banExpires: Date | number | null;
  policyScope: string;
  authEpoch: number;
  activationState: unknown;
  identityScopeHash: string;
  identityGeneration: number;
  scopeHash: string;
  scopeGeneration: number;
  snapshotGeneration: number;
  snapshotComplete: boolean;
  snapshotObservedAt: Date;
}

/** The injected read port returns every row so missing and ambiguity stay visible. */
export interface AuthenticationEligibilityDatabaseReader {
  read(input: AuthenticationEligibilityLookup): Promise<readonly AuthenticationAuthorityRow[]>;
}

export interface EligibilitySqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Creates the one-statement PostgreSQL authority reader. */
export function createPostgresAuthenticationEligibilityReader(
  pool: EligibilitySqlClient,
): AuthenticationEligibilityDatabaseReader {
  return {
    async read(input): Promise<readonly AuthenticationAuthorityRow[]> {
      const result = await pool.query(
        `select identity.id as "identityId",
                identity.local_user_id as "localUserId",
                identity.tenant_key as "tenantKey",
                identity.app_id as "appId",
                identity.status as "identityStatus",
                account.banned as "banned",
                account.ban_expires as "banExpires",
                policy.scope as "policyScope",
                policy.auth_epoch as "authEpoch",
                policy.activation_state as "activationState",
                identity_watermark.scope_hash as "identityScopeHash",
                identity_watermark.generation as "identityGeneration",
                scope_watermark.scope_hash as "scopeHash",
                scope_watermark.generation as "scopeGeneration",
                snapshot.generation as "snapshotGeneration",
                snapshot.complete as "snapshotComplete",
                snapshot.observed_at as "snapshotObservedAt"
           from "enterprise_identity" as identity
           join "user" as account
             on account.id = identity.local_user_id
           join "enterprise_policy" as policy
             on policy.scope = $5
           join "enterprise_directory_identity_watermarks" as identity_watermark
             on identity_watermark.identity_id = identity.id
           join "enterprise_directory_watermarks" as scope_watermark
             on scope_watermark.scope_hash = $6
           join "enterprise_directory_snapshots" as snapshot
             on snapshot.scope_hash = scope_watermark.scope_hash
            and snapshot.generation = scope_watermark.generation
          where identity.id = $1
            and identity.local_user_id = $2
            and identity.tenant_key = $3
            and identity.app_id = $4
            and not exists (select 1 from enterprise_quarantine as quarantine
                             where quarantine.user_id = identity.local_user_id
                               and quarantine.state <> 'released')`,
        [
          input.identityId,
          input.localUserId,
          input.tenantKey,
          input.appId,
          input.policyScope,
          input.directoryScopeHash,
        ],
      );
      return result.rows as AuthenticationAuthorityRow[];
    },
  };
}

export interface EnterpriseEligibilityServiceOptions {
  /** Tenant, app and approved departments are copied and factory-bound. */
  directoryScope: DirectoryScope;
  /** The unique enterprise_policy.scope of this deployment. */
  policyScope: string;
  /** Already parsed by the shared enterprise configuration contract. */
  authMode: AuthMode;
  databaseReader: AuthenticationEligibilityDatabaseReader;
  directoryReader: DirectoryAdmissionReader;
  now?: () => Date;
}

export interface EnterpriseEligibilityService {
  /** Provider-authoritative management admission; no local binding is required. */
  directoryAdmission(openId: string): Promise<boolean>;
  /** Database-authoritative business authentication; never calls the provider. */
  authenticationEligibility(
    localUserId: string,
    identityId: string,
    epoch: number,
  ): Promise<boolean>;
}

function requireFactoryText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(`[@megaui/engine] enterprise eligibility ${field} must not be empty`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isAuthorityRow(value: unknown): value is AuthenticationAuthorityRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.identityId === "string" &&
    value.identityId !== "" &&
    typeof value.localUserId === "string" &&
    value.localUserId !== "" &&
    typeof value.tenantKey === "string" &&
    value.tenantKey !== "" &&
    typeof value.appId === "string" &&
    value.appId !== "" &&
    typeof value.identityStatus === "string" &&
    (value.banned === null || typeof value.banned === "boolean") &&
    (value.banExpires === null ||
      isValidDate(value.banExpires) ||
      value.banExpires === Number.POSITIVE_INFINITY ||
      value.banExpires === Number.NEGATIVE_INFINITY) &&
    typeof value.policyScope === "string" &&
    value.policyScope !== "" &&
    Number.isSafeInteger(value.authEpoch) &&
    (value.authEpoch as number) >= 0 &&
    typeof value.identityScopeHash === "string" &&
    value.identityScopeHash !== "" &&
    Number.isSafeInteger(value.identityGeneration) &&
    (value.identityGeneration as number) >= 1 &&
    typeof value.scopeHash === "string" &&
    value.scopeHash !== "" &&
    Number.isSafeInteger(value.scopeGeneration) &&
    (value.scopeGeneration as number) >= 1 &&
    Number.isSafeInteger(value.snapshotGeneration) &&
    (value.snapshotGeneration as number) >= 1 &&
    typeof value.snapshotComplete === "boolean" &&
    isValidDate(value.snapshotObservedAt)
  );
}

function isAuthoritativeMember(value: unknown): value is AuthoritativeDirectoryMember {
  if (!isRecord(value) || typeof value.openId !== "string" || value.openId === "") return false;
  if (
    !Array.isArray(value.departmentIds) ||
    !value.departmentIds.every(
      (departmentId) => typeof departmentId === "string" && departmentId !== "",
    ) ||
    !isRecord(value.status)
  ) {
    return false;
  }
  return (
    typeof value.status.isActivated === "boolean" &&
    typeof value.status.isFrozen === "boolean" &&
    typeof value.status.isResigned === "boolean" &&
    typeof value.status.isExited === "boolean"
  );
}

/** Creates the only two server-side eligibility ports. */
export function createEnterpriseEligibilityService(
  options: EnterpriseEligibilityServiceOptions,
): EnterpriseEligibilityService {
  const tenantKey = requireFactoryText(options.directoryScope.tenantKey, "tenantKey");
  const appId = requireFactoryText(options.directoryScope.appId, "appId");
  const policyScope = requireFactoryText(options.policyScope, "policyScope");
  if (
    options.directoryReader.tenantKey !== tenantKey ||
    options.directoryReader.appId !== appId
  ) {
    throw new Error(
      "[@megaui/engine] the directory reader does not match the factory tenant and app",
    );
  }
  const departmentIds = [
    ...new Set(
      options.directoryScope.departmentIds.map((departmentId) =>
        requireFactoryText(departmentId, "approved department"),
      ),
    ),
  ];
  if (departmentIds.length === 0) {
    throw new Error("[@megaui/engine] enterprise eligibility requires an approved department");
  }
  const directoryScope: DirectoryScope = { tenantKey, appId, departmentIds };
  const directoryScopeHash = scopeHashOf(directoryScope);
  const approvedDepartments = new Set(departmentIds);
  const authMode = options.authMode;
  const readDirectoryMember = options.directoryReader.read.bind(options.directoryReader);
  const readAuthenticationAuthority = options.databaseReader.read.bind(options.databaseReader);
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    async directoryAdmission(openId: string): Promise<boolean> {
      if (typeof openId !== "string" || openId.trim() === "") return false;
      try {
        const member = await readDirectoryMember(openId);
        if (!isAuthoritativeMember(member) || member.openId !== openId) return false;
        const approved = member.departmentIds.some((departmentId) =>
          approvedDepartments.has(departmentId),
        );
        return (
          approved &&
          member.status.isActivated === true &&
          member.status.isFrozen === false &&
          member.status.isResigned === false &&
          member.status.isExited === false
        );
      } catch {
        return false;
      }
    },

    async authenticationEligibility(
      localUserId: string,
      identityId: string,
      epoch: number,
    ): Promise<boolean> {
      if (
        typeof localUserId !== "string" ||
        localUserId.trim() === "" ||
        typeof identityId !== "string" ||
        identityId.trim() === "" ||
        !Number.isSafeInteger(epoch) ||
        epoch < 0
      ) {
        return false;
      }

      try {
        const rows = await readAuthenticationAuthority({
          identityId,
          localUserId,
          tenantKey,
          appId,
          policyScope,
          directoryScopeHash,
        });
        if (!Array.isArray(rows) || rows.length !== 1) return false;
        const row: unknown = rows[0];
        if (!isAuthorityRow(row)) return false;
        const checkedAt = now();
        if (!isValidDate(checkedAt)) return false;

        const authorityMatches =
          row.identityId === identityId &&
          row.localUserId === localUserId &&
          row.tenantKey === tenantKey &&
          row.appId === appId &&
          row.policyScope === policyScope;
        const generationMatches =
          row.identityGeneration === row.scopeGeneration &&
          row.scopeGeneration === row.snapshotGeneration;
        const observationAge = checkedAt.getTime() - row.snapshotObservedAt.getTime();
        const directoryCurrent =
          row.identityScopeHash === directoryScopeHash &&
          row.scopeHash === directoryScopeHash &&
          generationMatches &&
          row.snapshotComplete &&
          observationAge >= 0 &&
          observationAge <= DIRECTORY_FRESHNESS_LIMIT_MS;

        return isAuthenticationEligible({
          authorityMatches,
          identityActive: row.identityStatus === "active",
          directoryCurrent,
          activeLocalBan: isActiveLocalBan({
            banned: row.banned,
            banExpires: row.banExpires,
            now: checkedAt,
          }),
          epochMatches: row.authEpoch === epoch,
          effectiveMode: resolveEffectiveAuthMode(authMode, row.activationState),
        });
      } catch {
        return false;
      }
    },
  });
}
