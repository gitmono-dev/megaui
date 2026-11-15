// megaui-only (FS-13): encrypted DM delivery is a real PostgreSQL worker boundary.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import { DIRECTORY_FRESHNESS_LIMIT_MS } from "./directory-sync";
import {
  createEnterpriseDmCleanupJobHandler,
  createEnterpriseDmDeliveryJobHandler,
  cleanupExpiredEnterpriseDmDeliveries,
} from "./delivery";
import {
  ENTERPRISE_DM_DELIVERY_QUEUE,
  ENTERPRISE_DM_RETRY_WINDOW_MS,
  type EnterpriseJob,
} from "./jobs";
import { scopeHashOf, type DirectoryScope } from "./feishu/directory";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] delivery.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const TENANT = "fs13-tenant";
const APP = "fs13-app";
const SCOPE = "fs13-scope";
const USER = "fs13-user";
const IDENTITY = "fs13-identity";
const OPEN_ID = "ou-fs13";
const EPOCH = 7;
const GENERATION = 3;
const FLOW = "a".repeat(64);
const DIRECTORY_SCOPE: DirectoryScope = { tenantKey: TENANT, appId: APP, departmentIds: ["od-approved"] };
const SCOPE_HASH = scopeHashOf(DIRECTORY_SCOPE);
const EXPECTATION = {
  processRole: "worker",
  ownerFingerprint: "megaui",
  instanceId: SCOPE,
  environment: "test",
} as const;

const crypto = {
  open(record: unknown): string | null {
    if (!record || typeof record !== "object") return null;
    const value = record as { encryptedPayload?: unknown; deliveryKeyId?: unknown };
    return value.deliveryKeyId === "fs13-delivery-v1" && value.encryptedPayload === "A".repeat(50)
      ? "2ABCD234"
      : null;
  },
};

let isolated: IsolatedPostgres;
let pool: Pool;
let now: Date;
let sent: { boundOpenId: string; code: string; uuid: string }[];
let messageResult: "accepted" | "unknown" | "rejected" = "accepted";

function jobRow(deliveryId: string, overrides: Record<string, unknown> = {}): EnterpriseJob & { attempts: number } {
  return {
    id: randomUUID(),
    queue: ENTERPRISE_DM_DELIVERY_QUEUE,
    payload: { deliveryId },
    attempts: 1,
    ...overrides,
  } as EnterpriseJob & { attempts: number };
}

async function insertFixture(options: {
  challengeState?: string;
  createdAt?: Date;
  expiresAt?: Date;
  firstAttemptAt?: Date | null;
  identityStatus?: string;
  identityVersion?: number;
  attempts?: number;
} = {}): Promise<{ challengeId: string; deliveryId: string; job: EnterpriseJob }> {
  const createdAt = options.createdAt ?? now;
  const expiresAt = options.expiresAt ?? new Date(createdAt.getTime() + 300_000);
  const challengeId = randomUUID();
  const deliveryId = randomUUID();
  const job = jobRow(deliveryId, { attempts: options.attempts ?? 1 });
  await pool.query(
    `insert into enterprise_identity
       (id, local_user_id, tenant_key, app_id, open_id, status, identity_version)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [IDENTITY, USER, TENANT, APP, OPEN_ID, options.identityStatus ?? "active", options.identityVersion ?? 1],
  );
  await pool.query(
    `insert into enterprise_challenges
       (id, scope, deployment_role, local_user_id, identity_id, identity_version,
        flow_hash, generation, purpose, pairing_id, code_hmac, hmac_key_id, state,
        failed_attempts, created_at, expires_at, consumed_at, recover_until,
        secret_expires_at)
     values ($1, $2, 'test', $3, $4, $5, $6, 1, 'login', null, $7, 'fs13-hmac-v1',
        $8, 0, $9, $10, $11, $12, $13)`,
    [
      challengeId,
      SCOPE,
      USER,
      IDENTITY,
      options.identityVersion ?? 1,
      FLOW,
      "a".repeat(64),
      options.challengeState ?? "active",
      createdAt,
      expiresAt,
      options.challengeState === "consumed" ? new Date(createdAt.getTime() + 290_000) : null,
      options.challengeState === "consumed" ? new Date(createdAt.getTime() + 380_000) : null,
      options.challengeState === "consumed" ? new Date(createdAt.getTime() + 380_000) : expiresAt,
    ],
  );
  await pool.query(
    `insert into enterprise_dm_deliveries
       (id, challenge_id, delivery_key_id, encrypted_payload, created_at, expires_at, first_attempt_at)
     values ($1, $2, 'fs13-delivery-v1', $3, $4, $5, $6)`,
    [deliveryId, challengeId, "A".repeat(50), createdAt, expiresAt, options.firstAttemptAt ?? null],
  );
  await pool.query(
    `insert into enterprise_jobs
       (id, queue, dedupe_key, payload, state, claim_owner, lease_until, attempts)
     values ($1, $2, $3, $4::jsonb, 'leased', 'fs13-worker', clock_timestamp() + interval '30 seconds', $5)`,
    [job.id, ENTERPRISE_DM_DELIVERY_QUEUE, `fs13-${job.id}`, JSON.stringify(job.payload), options.attempts ?? 1],
  );
  return { challengeId, deliveryId, job };
}

function handler(overrides: Record<string, unknown> = {}) {
  return createEnterpriseDmDeliveryJobHandler({
    pool,
    expectation: EXPECTATION,
    tenantKey: TENANT,
    appId: APP,
    directoryScope: DIRECTORY_SCOPE,
    authMode: "enterprise",
    crypto,
    messageClient: {
      send: async (input) => {
        sent.push(input);
        if (messageResult === "accepted") return { kind: "accepted", uuid: input.uuid, messageId: "om-fs13" };
        if (messageResult === "unknown") return { kind: "unknown", uuid: input.uuid, stage: "message", reason: "timeout" };
        return { kind: "rejected", uuid: input.uuid, reason: "permission", status: 403 };
      },
    },
    now: () => new Date(now),
    ...overrides,
  });
}

async function run(job: EnterpriseJob): Promise<void> {
  await handler()(job, { claimOwner: "fs13-worker", signal: new AbortController().signal });
}

describe("enterprise encrypted DM delivery (FS-13)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1_000 });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    now = new Date(Date.now());
    sent = [];
    messageResult = "accepted";
    await pool.query(`delete from enterprise_jobs; delete from enterprise_dm_deliveries; delete from enterprise_challenges;
      delete from enterprise_directory_identity_watermarks; delete from enterprise_directory_snapshots; delete from enterprise_directory_watermarks;
      delete from enterprise_identity; delete from enterprise_policy; delete from "user"`);
    await pool.query(
      `insert into "user" (id, name, email, email_verified, banned, ban_expires)
       values ($1, 'FS13 User', 'fs13@example.test', false, false, null)`,
      [USER],
    );
    await pool.query(
      `insert into enterprise_policy
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ('fs13-policy', $1, 'megaui', 'test', 'test', $2, 'enterprise')`,
      [SCOPE, EPOCH],
    );
    await pool.query(
      `insert into enterprise_directory_watermarks (id, scope_hash, generation)
       values ('fs13-scope-watermark', $1, $2)`,
      [SCOPE_HASH, GENERATION],
    );
    await pool.query(
      `insert into enterprise_directory_identity_watermarks (id, identity_id, scope_hash, generation)
       values ('fs13-identity-watermark', $1, $2, $3)`,
      [IDENTITY, SCOPE_HASH, GENERATION],
    );
    await pool.query(
      `insert into enterprise_directory_snapshots
         (id, scope_hash, generation, complete, member_count, observed_at, completed_at)
       values ('fs13-snapshot', $1, $2, true, 1, $3, $3)`,
      [SCOPE_HASH, GENERATION, new Date(now.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS + 1_000)],
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("opens and delivers the original code to the bound open_id with the delivery UUID", async () => {
    const fixture = await insertFixture();
    await run(fixture.job);
    expect(sent).toEqual([{ boundOpenId: OPEN_ID, code: "2ABCD234", uuid: fixture.deliveryId }]);
    expect((await pool.query("select sent_at from enterprise_dm_deliveries where id=$1", [fixture.deliveryId])).rows[0]?.sent_at).toBeTruthy();
  });

  it("allows no more than three unknown attempts and never creates an email task", async () => {
    messageResult = "unknown";
    const fixture = await insertFixture({ attempts: 1 });
    await expect(run(fixture.job)).rejects.toThrow("ENTERPRISE_DM_DELIVERY_RETRY");
    await pool.query("update enterprise_jobs set attempts=2 where id=$1", [fixture.job.id]);
    await expect(run(fixture.job)).rejects.toThrow("ENTERPRISE_DM_DELIVERY_RETRY");
    await pool.query("update enterprise_jobs set attempts=3 where id=$1", [fixture.job.id]);
    await expect(run(fixture.job)).resolves.toBeUndefined();
    expect(sent).toHaveLength(3);
    expect((await pool.query("select sent_at from enterprise_dm_deliveries where id=$1", [fixture.deliveryId])).rows[0]?.sent_at).toBeNull();
    expect((await pool.query("select to_regclass('public.enterprise_email_auth_tasks') as name")).rows[0]?.name).toBeNull();
  });

  it("does not send an expired challenge", async () => {
    const fixture = await insertFixture({
      createdAt: new Date(now.getTime() - 301_000),
      expiresAt: new Date(now.getTime() - 1_000),
    });
    await run(fixture.job);
    expect(sent).toEqual([]);
  });

  it("does not send a consumed challenge", async () => {
    const fixture = await insertFixture({
      challengeState: "consumed",
      createdAt: new Date(now.getTime() - 50_000),
      expiresAt: new Date(now.getTime() + 250_000),
    });
    await run(fixture.job);
    expect(sent).toEqual([]);
  });

  it("rechecks current qualification, including maintenance and identity version", async () => {
    const maintenance = await insertFixture();
    await pool.query("update enterprise_policy set activation_state='maintenance' where scope=$1", [SCOPE]);
    await run(maintenance.job);
    expect(sent).toEqual([]);

    await pool.query("delete from enterprise_jobs; delete from enterprise_dm_deliveries; delete from enterprise_challenges; delete from enterprise_identity");
    const version = await insertFixture();
    await pool.query("update enterprise_identity set identity_version=2 where id=$1", [IDENTITY]);
    await run(version.job);
    expect(sent).toEqual([]);
  });

  it("does not send after the provider idempotency window", async () => {
    const createdAt = new Date(now.getTime() - 60_000);
    const fixture = await insertFixture({
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 300_000),
      firstAttemptAt: new Date(now.getTime() - ENTERPRISE_DM_RETRY_WINDOW_MS - 1_000),
      attempts: 2,
    });
    await run(fixture.job);
    expect(sent).toEqual([]);
  });

  it("cleans expired ciphertext in a bounded page", async () => {
    const fixture = await insertFixture({ createdAt: new Date(now.getTime() - 301_000), expiresAt: new Date(now.getTime() - 1_000) });
    const deleted = await cleanupExpiredEnterpriseDmDeliveries(pool, now);
    expect(deleted).toBe(1);
    expect((await pool.query("select id from enterprise_dm_deliveries where id=$1", [fixture.deliveryId])).rows).toEqual([]);
    const cleanup = createEnterpriseDmCleanupJobHandler({ writer: pool, now: () => now });
    await cleanup({ id: randomUUID(), queue: "enterprise.dm-cleanup", payload: { scheduledFor: now.toISOString() } });
  });

  it("rejects an expired lease before opening the ciphertext", async () => {
    const fixture = await insertFixture();
    await pool.query("update enterprise_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [fixture.job.id]);
    await expect(run(fixture.job)).rejects.toThrow("ENTERPRISE_DM_DELIVERY_UNAVAILABLE");
    expect(sent).toEqual([]);
  });
});
