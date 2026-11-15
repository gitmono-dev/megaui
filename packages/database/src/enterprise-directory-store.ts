// megaui-only (FS-08): the enterprise directory store has no upstream counterpart.
/**
 * Atomic persistence for complete enterprise directory snapshots.
 *
 * One transaction advances the per-scope generation, records the complete
 * snapshot, and updates every eligible known identity watermark. The generation
 * upsert is the serialization point: an equal or older generation performs no other
 * write and can never overwrite a newer result.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

export interface DirectoryStoredIdentity {
  identityId: string;
  openId: string;
}

export interface DirectorySnapshotApplyInput {
  tenantKey: string;
  appId: string;
  scopeHash: string;
  /** The old authorized scope on the first run after a scope transition. */
  previousScopeHash?: string;
  generation: number;
  observedAt: Date;
  /** Every member ID in the complete provider page set, used only to derive member_count. */
  memberOpenIds: readonly string[];
  /** Snapshot-member subset allowed to advance identity eligibility watermarks. */
  watermarkOpenIds?: readonly string[];
}

export interface DirectorySnapshotApplyResult {
  applied: boolean;
  /** Known local identities tracked by the prior complete scope watermark. */
  previous: DirectoryStoredIdentity[];
}

export interface EnterpriseDirectoryStore {
  applyCompleteSnapshot(input: DirectorySnapshotApplyInput): Promise<DirectorySnapshotApplyResult>;
}

function requireText(value: string, field: string): void {
  if (value.trim() === "") {
    throw new Error(`[@megaui/database] directory snapshot ${field} must not be empty`);
  }
}

function validateInput(input: DirectorySnapshotApplyInput): {
  memberOpenIds: string[];
  watermarkOpenIds: string[];
} {
  requireText(input.tenantKey, "tenantKey");
  requireText(input.appId, "appId");
  requireText(input.scopeHash, "scopeHash");
  if (input.previousScopeHash !== undefined) {
    requireText(input.previousScopeHash, "previousScopeHash");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("[@megaui/database] directory snapshot generation must be a positive integer");
  }
  if (Number.isNaN(input.observedAt.getTime())) {
    throw new Error("[@megaui/database] directory snapshot observedAt must be valid");
  }
  const memberOpenIds = [...new Set(input.memberOpenIds)];
  for (const openId of memberOpenIds) requireText(openId, "memberOpenId");
  const watermarkOpenIds = [
    ...new Set(input.watermarkOpenIds === undefined ? memberOpenIds : input.watermarkOpenIds),
  ];
  const members = new Set(memberOpenIds);
  for (const openId of watermarkOpenIds) {
    requireText(openId, "watermarkOpenId");
    if (!members.has(openId)) {
      throw new Error(
        "[@megaui/database] directory snapshot watermarkOpenIds must be snapshot members",
      );
    }
  }
  return { memberOpenIds, watermarkOpenIds };
}

/** Creates a store over the caller-owned enterprise database pool. */
export function createEnterpriseDirectoryStore(pool: Pool): EnterpriseDirectoryStore {
  return {
    async applyCompleteSnapshot(
      input: DirectorySnapshotApplyInput,
    ): Promise<DirectorySnapshotApplyResult> {
      const { memberOpenIds, watermarkOpenIds } = validateInput(input);
      const client = await pool.connect();
      try {
        await client.query("begin");

        // This single statement is the compare-and-set and serialization point
        // for overlapping runs of one scope.
        const advanced = await client.query<{ generation: number }>(
          `insert into "enterprise_directory_watermarks" as watermark
             (id, scope_hash, generation)
           values ($1, $2, $3)
           on conflict (scope_hash) do update
             set generation = excluded.generation, updated_at = now()
             where watermark.generation < excluded.generation
           returning generation`,
          [randomUUID(), input.scopeHash, input.generation],
        );
        if (advanced.rows.length === 0) {
          await client.query("commit");
          return { applied: false, previous: [] };
        }

        const baselineScopeHash = input.previousScopeHash ?? input.scopeHash;
        const previous = await client.query<DirectoryStoredIdentity>(
          `select identity.id as "identityId", identity.open_id as "openId"
             from "enterprise_directory_identity_watermarks" as identity_watermark
             join "enterprise_identity" as identity
               on identity.id = identity_watermark.identity_id
            where identity_watermark.scope_hash = $1
              and identity.tenant_key = $2
              and identity.app_id = $3
            order by identity.id`,
          [baselineScopeHash, input.tenantKey, input.appId],
        );

        await client.query(
          `insert into "enterprise_directory_snapshots"
             (id, scope_hash, generation, complete, member_count, observed_at, completed_at)
           values ($1, $2, $3, true, $4, $5, $5)`,
          [
            randomUUID(),
            input.scopeHash,
            input.generation,
            memberOpenIds.length,
            input.observedAt,
          ],
        );

        if (watermarkOpenIds.length > 0) {
          const identities = await client.query<{ identityId: string }>(
            `select id as "identityId"
               from "enterprise_identity"
              where tenant_key = $1 and app_id = $2
                and open_id = any($3::text[])
              order by id`,
            [input.tenantKey, input.appId, watermarkOpenIds],
          );
          if (identities.rows.length > 0) {
            const identityIds = identities.rows.map((row) => row.identityId);
            await client.query(
              `insert into "enterprise_directory_identity_watermarks" as watermark
                 (id, identity_id, scope_hash, generation)
               select * from unnest($1::text[], $2::text[], $3::text[], $4::int[])
               on conflict (identity_id) do update
                 set scope_hash = excluded.scope_hash,
                     generation = excluded.generation,
                     updated_at = now()
                 where watermark.generation < excluded.generation`,
              [
                identityIds.map(() => randomUUID()),
                identityIds,
                identityIds.map(() => input.scopeHash),
                identityIds.map(() => input.generation),
              ],
            );
          }
        }

        await client.query("commit");
        return { applied: true, previous: previous.rows };
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
