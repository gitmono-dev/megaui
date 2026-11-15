// megaui-only (FS-46): trusted bot login is one sender-budget transaction.
import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";

import {
  createEnterpriseBotCommandService,
  type EnterpriseBotCommandInput,
} from "./bot-command";
import { createEnterpriseBotLoginService } from "./bot-login";
import {
  createEnterpriseEligibilityService,
  createPostgresAuthenticationEligibilityReader,
} from "./eligibility";
import { DIRECTORY_FRESHNESS_LIMIT_MS } from "./directory-sync";
import { scopeHashOf, type DirectoryScope } from "./feishu/directory";
import { createEnterpriseSenderBudget } from "./sender-budget";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] bot-login.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const TENANT = "tenant-1";
const APP = "app-1";
const SCOPE = "fs46";
const USER = "fs46-user";
const IDENTITY = "fs46-identity";
const OPEN_ID = "ou-fs46";
const EPOCH = 7;
const GENERATION = 4;
const FLOW = "a".repeat(64);
const TOKEN = "fs46-opaque-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const DIRECTORY_SCOPE: DirectoryScope = {
  tenantKey: TENANT,
  appId: APP,
  departmentIds: ["od-approved"],
};
const SCOPE_HASH = scopeHashOf(DIRECTORY_SCOPE);
const EXPECTATION = {
  processRole: "test",
  ownerFingerprint: "megaui",
  instanceId: SCOPE,
  environment: "test",
} as const;

const crypto = {
  digest: () => ({ codeHmac: "a".repeat(64), hmacKeyId: "fs46-hmac-v1" }),
  seal: () => ({ encryptedPayload: "A".repeat(50), deliveryKeyId: "fs46-delivery-v1" }),
};

let isolated: IsolatedPostgres;
let pool: Pool;
let now: Date;

function event(messageId = "om-fs46"): EnterpriseBotCommandInput {
  return {
    inboxId: `inbox-${messageId}`,
    tenantKey: TENANT,
    appId: APP,
    eventId: `event-${messageId}`,
    eventType: "im.message.receive_v1",
    eventCreatedAt: now,
    messageId,
    senderOpenId: OPEN_ID,
    senderType: "user",
    chatType: "p2p",
    messageType: "text",
    pairingTokenDigest: TOKEN_HASH,
  };
}

async function insertBaseline(): Promise<void> {
  await pool.query(
    `insert into "user" (id, name, email, email_verified, banned, ban_expires)
     values ($1, 'FS46 User', 'fs46@example.test', false, false, null)`,
    [USER],
  );
  await pool.query(
    `insert into enterprise_identity
       (id, local_user_id, tenant_key, app_id, open_id, status)
     values ($1, $2, $3, $4, $5, 'active')`,
    [IDENTITY, USER, TENANT, APP, OPEN_ID],
  );
  await pool.query(
    `insert into enterprise_policy
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('fs46-policy', $1, 'megaui', 'test', 'test', $2, 'enterprise')`,
    [SCOPE, EPOCH],
  );
  await pool.query(
    `insert into enterprise_directory_watermarks (id, scope_hash, generation)
     values ('fs46-scope-watermark', $1, $2)`,
    [SCOPE_HASH, GENERATION],
  );
  await pool.query(
    `insert into enterprise_directory_identity_watermarks
       (id, identity_id, scope_hash, generation)
     values ('fs46-identity-watermark', $1, $2, $3)`,
    [IDENTITY, SCOPE_HASH, GENERATION],
  );
  await pool.query(
    `insert into enterprise_directory_snapshots
       (id, scope_hash, generation, complete, member_count, observed_at, completed_at)
     values ('fs46-snapshot', $1, $2, true, 1, $3, $3)`,
    [SCOPE_HASH, GENERATION, new Date(now.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS + 1_000)],
  );
}

async function insertPairing(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  const createdAt = (overrides.created_at as Date | undefined) ?? now;
  const expiresAt = (overrides.expires_at as Date | undefined) ?? new Date(now.getTime() + 120_000);
  await pool.query(
    `insert into enterprise_pairings
       (id, scope, deployment_role, tenant_key, app_id, flow_hash, generation,
        token_hash, intended_identity_id, state, created_at, expires_at, retain_until)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      id,
      overrides.scope ?? SCOPE,
      overrides.deployment_role ?? "test",
      overrides.tenant_key ?? TENANT,
      overrides.app_id ?? APP,
      overrides.flow_hash ?? FLOW,
      overrides.generation ?? 1,
      overrides.token_hash ?? TOKEN_HASH,
      overrides.intended_identity_id ?? IDENTITY,
      overrides.state ?? "pending",
      createdAt,
      expiresAt,
    ],
  );
  return id;
}

function service(overrides: { botCommand?: ReturnType<typeof createEnterpriseBotCommandService> } = {}) {
  const eligibility = createEnterpriseEligibilityService({
    directoryScope: DIRECTORY_SCOPE,
    policyScope: SCOPE,
    authMode: "enterprise",
    databaseReader: createPostgresAuthenticationEligibilityReader(pool),
    directoryReader: {
      tenantKey: TENANT,
      appId: APP,
      read: async () => Promise.reject(new Error("FS-46 must not call provider")),
    },
    now: () => new Date(now),
  });
  const botCommand = overrides.botCommand ?? createEnterpriseBotCommandService({
    pool,
    expectation: EXPECTATION,
    tenantKey: TENANT,
    appId: APP,
    eligibility,
  });
  return createEnterpriseBotLoginService({
    pool,
    expectation: EXPECTATION,
    tenantKey: TENANT,
    appId: APP,
    directoryScope: DIRECTORY_SCOPE,
    authMode: "enterprise",
    botCommand,
    crypto,
    generateCode: () => "2ABCD234",
  });
}

describe("enterprise bot login (FS-46)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1_000 });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    now = new Date(Date.now());
    await pool.query(`delete from enterprise_dm_deliveries`);
    await pool.query(`delete from enterprise_challenges`);
    await pool.query(`delete from enterprise_login_budgets`);
    await pool.query(`delete from enterprise_pairings`);
    await pool.query(`delete from enterprise_profile`);
    await pool.query(`delete from enterprise_directory_identity_watermarks`);
    await pool.query(`delete from enterprise_directory_snapshots`);
    await pool.query(`delete from enterprise_directory_watermarks`);
    await pool.query(`delete from enterprise_identity`);
    await pool.query(`delete from enterprise_policy`);
    await pool.query(`delete from "user"`);
    await insertBaseline();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("rejects an expired pairing before charging sender budget", async () => {
    await insertPairing({
      created_at: new Date(now.getTime() - 121_000),
      expires_at: new Date(now.getTime() - 1_000),
    });
    await expect(service().consume(event())).resolves.toEqual({
      kind: "rejected",
      reason: "expired-pairing",
    });
    expect((await pool.query(`select count(*)::int as count from enterprise_login_budgets`)).rows[0]?.count).toBe(0);
  });

  it("rejects a pairing from another deployment", async () => {
    await insertPairing({ deployment_role: "production" });
    await expect(service().consume(event())).resolves.toEqual({
      kind: "rejected",
      reason: "unknown-pairing",
    });
  });

  it("commits pairing, challenge and encrypted delivery together", async () => {
    const pairingId = await insertPairing();
    const result = await service().consume(event());
    expect(result).toMatchObject({ kind: "accepted" });
    const rows = await pool.query<{ pairing_state: string; message_id: string; challenges: number; deliveries: number; budgets: number }>(
      `select pairing.state as pairing_state,
              pairing.confirmed_message_id as message_id,
              (select count(*)::int from enterprise_challenges) as challenges,
              (select count(*)::int from enterprise_dm_deliveries) as deliveries,
              (select count(*)::int from enterprise_login_budgets) as budgets
         from enterprise_pairings pairing where pairing.id = $1`,
      [pairingId],
    );
    expect(rows.rows[0]).toMatchObject({ pairing_state: "confirmed", message_id: "om-fs46", challenges: 1, deliveries: 1, budgets: 2 });
  });

  it("does not create a second challenge for a replayed message_id", async () => {
    await insertPairing();
    await expect(service().consume(event())).resolves.toMatchObject({ kind: "accepted" });
    await expect(service().consume(event())).resolves.toEqual({ kind: "rejected", reason: "expired-pairing" });
    expect((await pool.query(`select count(*)::int as count from enterprise_challenges`)).rows[0]?.count).toBe(1);
    expect((await pool.query(`select count(*)::int as count from enterprise_dm_deliveries`)).rows[0]?.count).toBe(1);
  });

  it("rechecks current eligibility inside the sender-budget transaction", async () => {
    await insertPairing();
    const base = createEnterpriseBotCommandService({
      pool,
      expectation: EXPECTATION,
      tenantKey: TENANT,
      appId: APP,
      eligibility: createEnterpriseEligibilityService({
        directoryScope: DIRECTORY_SCOPE,
        policyScope: SCOPE,
        authMode: "enterprise",
        databaseReader: createPostgresAuthenticationEligibilityReader(pool),
        directoryReader: { tenantKey: TENANT, appId: APP, read: async () => Promise.reject(new Error("no provider")) },
        now: () => new Date(now),
      }),
    });
    const race = {
      admit: async (input: EnterpriseBotCommandInput) => {
        const result = await base.admit(input);
        if (result.kind === "accepted") await pool.query(`update enterprise_identity set status='suspended' where id=$1`, [IDENTITY]);
        return result;
      },
      admitInbox: async (inboxId: string) => base.admitInbox(inboxId),
    };
    await expect(service({ botCommand: race }).consume(event())).resolves.toEqual({ kind: "unavailable" });
    expect((await pool.query(`select count(*)::int as count from enterprise_challenges`)).rows[0]?.count).toBe(0);
    expect((await pool.query(`select count(*)::int as count from enterprise_login_budgets`)).rows[0]?.count).toBe(0);
  });

  it("does not create challenge or delivery when the sender budget is full", async () => {
    await insertPairing();
    const budget = createEnterpriseSenderBudget({ pool, expectation: EXPECTATION, tenantKey: TENANT, appId: APP });
    await expect(budget.run({ senderOpenId: OPEN_ID, identityId: IDENTITY, flowHash: FLOW, validToken: true }, async () => "reserved")).resolves.toEqual({ kind: "accepted", value: "reserved" });
    const nextPairing = createHash("sha256").update("next").digest("hex");
    await pool.query(`update enterprise_pairings set token_hash=$1, flow_hash=$2 where scope=$3`, [nextPairing, "b".repeat(64), SCOPE]);
    await expect(service().consume({ ...event("om-next"), pairingTokenDigest: nextPairing })).resolves.toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect((await pool.query(`select count(*)::int as count from enterprise_challenges`)).rows[0]?.count).toBe(0);
    expect((await pool.query(`select count(*)::int as count from enterprise_dm_deliveries`)).rows[0]?.count).toBe(0);
  });

  it("rolls back pairing confirmation and budget when delivery persistence fails", async () => {
    const pairingId = await insertPairing();
    await pool.query(`
      create function fs46_delivery_failure() returns trigger language plpgsql as $$
      begin raise exception 'FS46 synthetic delivery failure'; end $$;
      create trigger fs46_delivery_failure before insert on enterprise_dm_deliveries
      for each row execute function fs46_delivery_failure()`);
    try {
      await expect(service().consume(event())).resolves.toEqual({ kind: "unavailable" });
    } finally {
      await pool.query(`drop trigger if exists fs46_delivery_failure on enterprise_dm_deliveries; drop function if exists fs46_delivery_failure()`);
    }
    expect((await pool.query(`select state from enterprise_pairings where id=$1`, [pairingId])).rows[0]?.state).toBe("pending");
    expect((await pool.query(`select count(*)::int as count from enterprise_challenges`)).rows[0]?.count).toBe(0);
    expect((await pool.query(`select count(*)::int as count from enterprise_dm_deliveries`)).rows[0]?.count).toBe(0);
    expect((await pool.query(`select count(*)::int as count from enterprise_login_budgets`)).rows[0]?.count).toBe(0);
  });
});
