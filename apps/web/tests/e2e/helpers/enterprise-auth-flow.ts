// megaui-only (FS-89): normal enterprise OTP and legacy Cookie fixtures.
import { createEnterpriseOtpCrypto, generateEnterpriseOtpCode } from "@megaui/auth";
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createEnterpriseEligibilityService, createPostgresAuthenticationEligibilityReader } from "@megaui/engine";
import { createEnterpriseBotCommandService } from "../../../../../packages/engine/src/services/enterprise/bot-command";
import { createEnterpriseBotLoginService } from "../../../../../packages/engine/src/services/enterprise/bot-login";
import { scopeHashOf } from "../../../../../packages/engine/src/services/enterprise/feishu/directory";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { createEnterpriseWebFixture, type EnterpriseWebFixture } from "./enterprise-fixture";
import { projectSimulatorRuntime } from "./enterprise-env";
import { startFeishuMock, type StartedFeishuMock } from "./feishu-mock";
import { createIsolatedSmtp } from "../../../../../packages/email/src/test-support/isolated-smtp";

const DEPARTMENT_IDS = ["od_mock_engineering", "od_mock_operations"] as const;
const HMAC_KEY = Buffer.alloc(32, 0x89);
const DELIVERY_KEY = Buffer.alloc(32, 0x90);
const HMAC_KEY_B64 = HMAC_KEY.toString("base64url");
const DELIVERY_KEY_B64 = DELIVERY_KEY.toString("base64url");
const OPEN_ID = "ou_mock_alice";

export interface EnterpriseAuthFlowFixture {
  readonly web: EnterpriseWebFixture;
  readonly mock: StartedFeishuMock;
  readonly login: (input: { readonly pairingId: string; readonly pairingToken: string; readonly flowCookie: string }) => Promise<{
    readonly challengeId: string;
    readonly code: string;
  }>;
  readonly userId: string;
  readonly email: string;
  readonly close: () => Promise<void>;
}

export interface LegacyAuthFlowFixture {
  readonly web: EnterpriseWebFixture;
  readonly smtp: IsolatedSmtp;
  readonly email: string;
  readonly close: () => Promise<void>;
}

async function seedEnterpriseAccount(web: EnterpriseWebFixture, mock: StartedFeishuMock): Promise<{ userId: string; email: string }> {
  const userId = `fs89-user-${web.database.runId}`;
  const historyUserId = `fs89-history-${web.database.runId}`;
  const identityId = `fs89-identity-${web.database.runId}`;
  const email = `fs89-${web.database.runId}@example.test`;
  const historyEmail = `fs89-history-${web.database.runId}@example.test`;
  const operationId = randomUUID();
  const now = new Date();
  const scope = { tenantKey: mock.runtime.tenantKey, appId: mock.runtime.appId, departmentIds: DEPARTMENT_IDS };
  const scopeHash = scopeHashOf(scope);
  const sourceDigest = createHash("sha256").update(`fs89-source:${web.database.runId}`, "utf8").digest("hex");
  const subjectsDigest = createHash("sha256").update(`fs89-subjects:${historyUserId}`, "utf8").digest("hex");
  const ownershipDigest = createHash("sha256").update(`fs89-ownership:${historyUserId}`, "utf8").digest("hex");
  const values = [
    userId, "FS89 Synthetic Alice", email, now,
    mock.runtime.tenantKey, "fs89-alice", `fs89-backend-${web.database.runId}`, "FS89 Synthetic Alice", "alice@example.com",
    identityId, mock.runtime.appId, OPEN_ID, "on_mock_alice",
    `fs89-snapshot-${web.database.runId}`, scopeHash, `fs89-watermark-${web.database.runId}`, `fs89-identity-watermark-${web.database.runId}`,
  ];
  const client = await web.admin.pool.connect();
  try {
    await client.query("begin");
    await client.query(`insert into "user" (id,name,email,email_verified,created_at,updated_at)
      values ($1,$2,$3,false,$4,$4)`, values.slice(0, 4));
    await client.query(`insert into "user" (id,name,email,email_verified,created_at,updated_at)
      values ($1,$2,$3,true,$4,$4)`, [historyUserId, "FS89 Historical Synthetic", historyEmail, now]);
    await client.query(`insert into account (id,account_id,provider_id,user_id,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$5)`, [`fs89-account-${web.database.runId}`, `fs89-historical-account-${web.database.runId}`, "feishu-history", historyUserId, now]);
    await client.query(`insert into enterprise_profile (user_id,tenant_key,login_name,backend_username,display_name,notification_email,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$7)`, [values[0], values[4], values[5], values[6], values[7], values[8], values[3]]);
    await client.query(`insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id,union_id,status,identity_version,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,'active',1,$7,$7)`, [values[9], values[0], values[4], values[10], values[11], values[12], values[3]]);
    await client.query(`insert into enterprise_directory_snapshots
      (id,scope_hash,generation,complete,member_count,observed_at,completed_at,created_at,updated_at)
      values ($1,$2,1,true,3,$3,$3,$3,$3)`, [values[13], values[14], values[3]]);
    await client.query(`insert into enterprise_directory_watermarks (id,scope_hash,generation,updated_at)
      values ($1,$2,1,$3)`, [values[15], values[14], values[3]]);
    await client.query(`insert into enterprise_directory_identity_watermarks (id,identity_id,scope_hash,generation,updated_at)
      values ($1,$2,$3,1,$4)`, [values[16], values[9], values[14], values[3]]);
    await client.query(`insert into enterprise_admin_operations
      (id,operation_id,verb,manifest_digest,expected_user_version,expected_identity_version,state,result,attempts,created_at,updated_at)
      values ($1,$2,'seed-fixture',$3,1,1,'completed',$4::jsonb,1,$5,$5)`, [
      `fs89-operation-row-${web.database.runId}`, operationId, sourceDigest,
      JSON.stringify({ fixture: "fs89", scope: web.database.runId }), now,
    ]);
    await client.query(`insert into enterprise_actor_inventory
      (scope,operation_id,source_digest,subjects_digest,ownership_digest,observed_at,upstream_actors)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
      web.database.runId, operationId, sourceDigest, subjectsDigest, ownershipDigest, now,
      JSON.stringify([{ actor: `mgu_fs89_historical_${web.database.runId}`, owners: [historyUserId] }]),
    ]);
    await client.query(`insert into enterprise_actor_reservations
      (id,backend_username,actor_state,local_user_id,quarantined,source_snapshot_digest,source_observed_at,created_at,updated_at)
      values ($1,$2,'reserved',$3,false,$4,$5,$5,$5)`, [
      `fs89-actor-reservation-${web.database.runId}`, `mgu_fs89_historical_${web.database.runId}`, historyUserId, sourceDigest, now,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { userId, email };
}

function applyEnterpriseRuntime(web: EnterpriseWebFixture, mock: StartedFeishuMock): void {
  const projection = projectSimulatorRuntime({
    ...mock.runtime,
    baseUrl: mock.baseUrl,
  });
  Object.assign(web.server.env, projection, {
    FEISHU_DIRECTORY_DEPARTMENT_IDS: JSON.stringify(DEPARTMENT_IDS),
    ENTERPRISE_OTP_HMAC_KEY: HMAC_KEY_B64,
    ENTERPRISE_DELIVERY_KEY: DELIVERY_KEY_B64,
  });
}

async function waitForInbox(web: EnterpriseWebFixture, senderOpenId: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await web.admin.pool.query<{ id: string }>(`select id from enterprise_event_inbox
      where event_type='im.message.receive_v1' and sender_open_id=$1 and pairing_token_digest is not null
      order by event_created_at desc limit 1`, [senderOpenId]);
    if (result.rows[0]?.id) return result.rows[0].id;
    await delay(100);
  }
  throw new Error("FS89 did not observe the verified login message");
}

export async function createEnterpriseAuthFlowFixture(): Promise<EnterpriseAuthFlowFixture> {
  const web = await createEnterpriseWebFixture("enterprise");
  let mock: StartedFeishuMock | undefined;
  let authDatabase: DatabaseClient | undefined;
  try {
    mock = await startFeishuMock({ callbackUrl: `${web.origin}/api/integrations/feishu/events` });
    applyEnterpriseRuntime(web, mock);
    await web.restart();
    const account = await seedEnterpriseAccount(web, mock);
    authDatabase = createDatabaseClient({
      connectionString: web.server.env.DATABASE_URL!,
      connectionTimeoutMillis: 1_000,
      statementTimeoutMillis: 3_000,
      onPoolError: () => undefined,
    });
    const expectation = {
      processRole: "web" as const,
      ownerFingerprint: "fs40-owner",
      instanceId: web.database.runId,
      environment: "test" as const,
    };
    const directoryScope = { tenantKey: mock.runtime.tenantKey, appId: mock.runtime.appId, departmentIds: DEPARTMENT_IDS };
    const eligibility = createEnterpriseEligibilityService({
      directoryScope,
      policyScope: web.database.runId,
      authMode: "enterprise",
      databaseReader: createPostgresAuthenticationEligibilityReader(web.admin.pool),
      directoryReader: { tenantKey: directoryScope.tenantKey, appId: directoryScope.appId, read: async () => { throw new Error("FS89 must not call provider"); } },
    });
    let latestCode: string | undefined;
    const crypto = createEnterpriseOtpCrypto({ hmacKeyId: "enterprise-otp-v1", hmacKey: HMAC_KEY, deliveryKeyId: "enterprise-delivery-v1", deliveryKey: DELIVERY_KEY });
    const botCommand = createEnterpriseBotCommandService({ pool: authDatabase.pool, expectation, tenantKey: directoryScope.tenantKey, appId: directoryScope.appId, eligibility });
    const botLogin = createEnterpriseBotLoginService({
      pool: authDatabase.pool, expectation, tenantKey: directoryScope.tenantKey, appId: directoryScope.appId,
      directoryScope, authMode: "enterprise", botCommand, crypto,
      generateCode: () => { latestCode = generateEnterpriseOtpCode(); return latestCode; },
    });
    const ownedMock = mock;
    return {
      web, mock: ownedMock, userId: account.userId, email: account.email,
      login: async ({ pairingId, pairingToken, flowCookie }) => {
        const message = await fetch(`${ownedMock.baseUrl}/__mock/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${ownedMock.runtime.adminToken}`, "content-type": "application/json" },
          body: JSON.stringify({ openId: OPEN_ID, text: `/login ${pairingToken}`, encrypted: true }),
        });
        if (!message.ok) throw new Error(`FS89 Mock DM failed: ${message.status}`);
        const inboxId = await waitForInbox(web, OPEN_ID);
        const result = await botLogin.consume({ inboxId });
        if (result.kind !== "accepted" || !latestCode) {
          const rows = await web.admin.pool.query(`select id,state,scope,deployment_role,tenant_key,app_id,purpose,intended_identity_id,flow_hash from enterprise_pairings where scope=$1 order by created_at desc limit 2`, [web.database.runId]);
          throw new Error(`FS89 bot login did not accept: ${JSON.stringify({ result, rows: rows.rows })}`);
        }
        if (pairingId.length === 0 || flowCookie.length === 0) throw new Error("FS89 pairing flow missing");
        const expectedFlowHash = createHash("sha256").update(flowCookie, "utf8").digest("hex");
        const challenge = await web.admin.pool.query<{ flow_hash: string }>("select flow_hash from enterprise_challenges where id=$1", [result.challengeId]);
        if (challenge.rows[0]?.flow_hash !== expectedFlowHash) throw new Error(`FS89 flow cookie binding mismatch: ${JSON.stringify({ actual: challenge.rows[0]?.flow_hash, expected: expectedFlowHash })}`);
        return { challengeId: result.challengeId, code: latestCode };
      },
      close: async () => {
        const failures: unknown[] = [];
        try { await ownedMock.stop(); } catch (error) { failures.push(error); }
        try { await authDatabase?.close(); } catch (error) { failures.push(error); }
        try { await web.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "FS89 enterprise fixture cleanup failed");
      },
    };
  } catch (error) {
    try { await mock?.stop(); } catch { /* Preserve setup error. */ }
    try { await authDatabase?.close(); } catch { /* Preserve setup error. */ }
    try { await web.close(); } catch { /* Preserve setup error. */ }
    throw error;
  }
}

export async function createLegacyAuthFlowFixture(): Promise<LegacyAuthFlowFixture> {
  const web = await createEnterpriseWebFixture("legacy");
  let smtp: IsolatedSmtp | undefined;
  try {
    smtp = await createIsolatedSmtp(web.database.runId);
    Object.assign(web.server.env, {
      EMAIL_PROVIDER: "smtp",
      SMTP_HOST: smtp.host,
      SMTP_PORT: String(smtp.port),
      SMTP_USER: "",
      SMTP_PASS: "",
    });
    await web.restart();
    return {
      web, smtp, email: `fs89-legacy-${web.database.runId}@example.test`,
      close: async () => {
        const failures: unknown[] = [];
        try { await smtp!.close(); } catch (error) { failures.push(error); }
        try { await web.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "FS89 legacy fixture cleanup failed");
      },
    };
  } catch (error) {
    try { await smtp?.close(); } catch { /* Preserve setup error. */ }
    try { await web.close(); } catch { /* Preserve setup error. */ }
    throw error;
  }
}
