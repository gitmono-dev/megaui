// megaui-only (FS-76): verified bot-command admission on owned PostgreSQL.
import { createHash } from "node:crypto";

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
import {
  createEnterpriseEligibilityService,
  createPostgresAuthenticationEligibilityReader,
} from "./eligibility";
import { DIRECTORY_FRESHNESS_LIMIT_MS } from "./directory-sync";
import { scopeHashOf, type DirectoryScope } from "./feishu/directory";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] bot-command.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

const TENANT = "tenant-1";
const APP = "app-1";
const SCOPE = "fs76";
const USER = "fs76-user";
const IDENTITY = "fs76-identity";
const OPEN_ID = "ou-fs76";
const EPOCH = 7;
const GENERATION = 4;
const TOKEN = "fs76-opaque-token";
const DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
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

let isolated: IsolatedPostgres;
let pool: Pool;
let now: Date;

function event(overrides: Record<string, unknown> = {}): EnterpriseBotCommandInput {
  return {
    inboxId: "fs76-inbox",
    tenantKey: TENANT,
    appId: APP,
    eventId: "fs76-event",
    eventType: "im.message.receive_v1",
    eventCreatedAt: now,
    messageId: "fs76-message",
    senderOpenId: OPEN_ID,
    senderType: "user",
    chatType: "p2p",
    messageType: "text",
    pairingTokenDigest: DIGEST,
    ...overrides,
  } as EnterpriseBotCommandInput;
}

async function insertBaseline(): Promise<void> {
  await pool.query(
    `insert into "user" (id, name, email, email_verified, banned, ban_expires)
     values ($1, 'FS76 User', 'fs76@example.test', false, false, null)`,
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
     values ('fs76-policy', $1, 'megaui', 'test', 'test', $2, 'enterprise')`,
    [SCOPE, EPOCH],
  );
  await pool.query(
    `insert into enterprise_directory_watermarks (id, scope_hash, generation)
     values ('fs76-scope-watermark', $1, $2)`,
    [SCOPE_HASH, GENERATION],
  );
  await pool.query(
    `insert into enterprise_directory_identity_watermarks
       (id, identity_id, scope_hash, generation)
     values ('fs76-identity-watermark', $1, $2, $3)`,
    [IDENTITY, SCOPE_HASH, GENERATION],
  );
  await pool.query(
    `insert into enterprise_directory_snapshots
       (id, scope_hash, generation, complete, member_count, observed_at, completed_at)
     values ('fs76-snapshot', $1, $2, true, 1, $3, $3)`,
    [SCOPE_HASH, GENERATION, new Date(now.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS + 1_000)],
  );
  await pool.query(
    `insert into enterprise_profile
       (user_id, tenant_key, login_name, backend_username)
     values ($1, $2, 'fs76.alias', 'fs76.backend')`,
    [USER, TENANT],
  );
  await pool.query(
    `insert into enterprise_pairings
       (id, scope, deployment_role, tenant_key, app_id, flow_hash, generation,
        token_hash, intended_identity_id, state, created_at, expires_at, retain_until)
     values ('00000000-0000-4000-8000-000000000076', $1, 'test', $2, $3, $4, 1,
        $5, $6, 'pending', $7::timestamptz, $7::timestamptz + interval '120 seconds',
        $7::timestamptz + interval '120 seconds')`,
    [SCOPE, TENANT, APP, "a".repeat(64), DIGEST, IDENTITY, now],
  );
}

function service() {
  const eligibility = createEnterpriseEligibilityService({
    directoryScope: DIRECTORY_SCOPE,
    policyScope: SCOPE,
    authMode: "enterprise",
    databaseReader: createPostgresAuthenticationEligibilityReader(pool),
    directoryReader: {
      tenantKey: TENANT,
      appId: APP,
      read: async () => Promise.reject(new Error("FS-76 must not call provider")),
    },
    now: () => new Date(now),
  });
  return createEnterpriseBotCommandService({
    pool,
    expectation: EXPECTATION,
    tenantKey: TENANT,
    appId: APP,
    eligibility,
  });
}

describe("enterprise bot-command admission (FS-76)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    now = new Date(Date.now());
    await pool.query(`delete from enterprise_event_inbox`);
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

  it("accepts only the strict login digest and current bound identity", async () => {
    await expect(service().admit(event())).resolves.toMatchObject({
      kind: "accepted",
      pairingId: "00000000-0000-4000-8000-000000000076",
      identityId: IDENTITY,
      localUserId: USER,
    });
    await pool.query(
      `insert into enterprise_event_inbox
         (id, tenant_key, app_id, event_id, event_type, event_created_at,
          message_id, sender_open_id, sender_type, chat_type, message_type,
          pairing_token_digest)
       values ('fs76-inbox', $1, $2, 'fs76-event', 'im.message.receive_v1', $3,
          'fs76-message', $4, 'user', 'p2p', 'text', $5)`,
      [TENANT, APP, now, OPEN_ID, DIGEST],
    );
    await expect(service().admitInbox("fs76-inbox")).resolves.toMatchObject({
      kind: "accepted",
      pairingId: "00000000-0000-4000-8000-000000000076",
    });
    await expect(service().admit(event({ pairingTokenDigest: undefined }))).resolves.toEqual({
      kind: "rejected",
      reason: "not-a-login-command",
    });
  });

  it("rejects group-chat commands", async () => {
    await expect(service().admit(event({ chatType: "group" }))).resolves.toEqual({
      kind: "rejected",
      reason: "group-chat",
    });
  });

  it("rejects bot senders", async () => {
    await expect(service().admit(event({ senderType: "bot" }))).resolves.toEqual({
      kind: "rejected",
      reason: "bot-sender",
    });
  });

  it("rejects non-text messages", async () => {
    await expect(service().admit(event({ messageType: "image" }))).resolves.toEqual({
      kind: "rejected",
      reason: "non-text",
    });
  });

  it("requires the sender open_id to match the pairing identity", async () => {
    await expect(service().admit(event({ senderOpenId: "ou-other" }))).resolves.toEqual({
      kind: "rejected",
      reason: "sender-mismatch",
    });
  });

  it("rejects suspended identities", async () => {
    await pool.query(`update enterprise_identity set status = 'suspended' where id = $1`, [IDENTITY]);
    await expect(service().admit(event())).resolves.toEqual({
      kind: "rejected",
      reason: "ineligible-identity",
    });
  });

  it("rejects a stale directory watermark", async () => {
    await pool.query(
      `update enterprise_directory_snapshots
          set observed_at = $1
        where scope_hash = $2`,
      [new Date(now.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS - 1), SCOPE_HASH],
    );
    await expect(service().admit(event())).resolves.toEqual({
      kind: "rejected",
      reason: "ineligible-identity",
    });
  });

  it("rejects a locally banned identity", async () => {
    await pool.query(`update "user" set banned = true where id = $1`, [USER]);
    await expect(service().admit(event())).resolves.toEqual({
      kind: "rejected",
      reason: "ineligible-identity",
    });
  });
});
