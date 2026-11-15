// FS-21：成功登录通知队列与补偿。
//
// The fixture uses a fresh Postgres database and a recording sender.  No test
// talks to SMTP or a real provider; the service boundary is the only sender
// that can be called.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";
import {
  createEnterpriseNotificationJobHandler,
  createEnterpriseNotificationsService,
  type EnterpriseNotificationSender,
} from "./notifications";
import { ENTERPRISE_NOTIFICATION_QUEUE } from "./jobs";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/engine] notifications.integration.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

interface MemberFixture {
  userId: string;
  identityId: string;
  grantId: string;
}

interface RecordedDelivery {
  to: string;
  params: Record<string, unknown>;
}

let isolated: IsolatedPostgres;
let pool: Pool;
const currentNow = new Date("2026-11-13T00:01:00.000Z");
const members = new Map<number, MemberFixture>();
const deliveries: RecordedDelivery[] = [];
let senderShouldFail = false;

function uuidFor(number: number): string {
  const suffix = number.toString(16).padStart(2, "0").repeat(6);
  return `00000000-0000-4000-8000-${suffix}`;
}

async function seedMember(index: number, notificationEmail: string | null): Promise<MemberFixture> {
  const userId = `fs21-user-${index}`;
  const identityId = `fs21-identity-${index}`;
  const grantId = uuidFor(index + 20);
  const challengeId = uuidFor(index);
  const flowHash = index.toString(16).repeat(64).slice(0, 64);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, false)`,
    [userId, `FS21 User ${index}`, `compat${index}@identity.invalid`],
  );
  await pool.query(
    `insert into enterprise_identity
       (id, local_user_id, tenant_key, app_id, open_id, identity_version)
     values ($1, $2, 'fs21-tenant', 'fs21-app', $3, 1)`,
    [identityId, userId, `fs21-open-${index}`],
  );
  await pool.query(
    `insert into enterprise_profile
       (user_id, tenant_key, login_name, backend_username, display_name,
        notification_email, created_at, updated_at)
     values ($1, 'fs21-tenant', $2, $3, $4, $5, $6, $6)`,
    [
      userId,
      `member${index}`,
      `mgu_fs21_${index}`,
      `Display ${index}`,
      notificationEmail,
      "2026-11-13T00:00:00.000Z",
    ],
  );
  await pool.query(
    `insert into enterprise_challenges
       (id, scope, deployment_role, local_user_id, identity_id, identity_version,
        flow_hash, generation, purpose, state, failed_attempts, created_at,
        expires_at, secret_expires_at, code_hmac, hmac_key_id)
     values ($1, 'fs21-scope', 'test', $2, $3, 1, $4, $5, 'login',
       'active', 0, '2026-11-13T00:00:00.000Z',
       '2026-11-13T00:05:00.000Z', '2026-11-13T00:05:00.000Z', $6, 'fs21-key')`,
    [challengeId, userId, identityId, flowHash, index, index.toString(16).repeat(64).slice(0, 64)],
  );
  await pool.query(
    `insert into enterprise_login_grants
       (id, challenge_id, scope, deployment_role, local_user_id, identity_id,
        identity_version, auth_epoch, flow_hash, generation, purpose,
        created_at, recover_until)
     values ($1, $2, 'fs21-scope', 'test', $3, $4, 1, 1, $5, $6, 'login',
       '2026-11-13T00:00:00.000Z', '2026-11-13T00:03:00.000Z')`,
    [grantId, challengeId, userId, identityId, flowHash, index],
  );
  await pool.query(
    `insert into session
       (id, expires_at, token, created_at, updated_at, ip_address, user_agent,
        user_id, enterprise_grant_id, enterprise_identity_id, auth_epoch, auth_method)
     values ($1, '2026-11-14T00:00:00.000Z', $2, '2026-11-13T00:00:00.000Z',
       '2026-11-13T00:00:00.000Z', $3, $4, $5, $6, $7, 1, 'enterprise')`,
    [
      `fs21-session-${index}`,
      `fs21-session-token-${index}`,
      `203.0.113.${index}`,
      `Chromium FS21/${index}`,
      userId,
      grantId,
      identityId,
    ],
  );
  const member = { userId, identityId, grantId };
  members.set(index, member);
  return member;
}

const sender: EnterpriseNotificationSender = {
  async sendEnterpriseLoginNotificationEmail(to, params) {
    deliveries.push({ to, params: { ...params } });
    if (senderShouldFail) throw new Error("SMTP_DOWN");
    return { id: `mail-${deliveries.length}` } as never;
  },
};

describe("enterprise notification reconciliation (FS-21)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    await pool.query(
      `insert into enterprise_policy
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ('fs21-policy', 'fs21-scope', '${"a".repeat(64)}', 'test', 'test', 1, 'enterprise')`,
    );
    await seedMember(1, "notify1@example.test");
    await seedMember(2, null);
    await seedMember(3, "notify3@example.test");
    await seedMember(4, "notify4@example.test");
    await seedMember(5, "notify5@example.test");
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  function createService() {
    return createEnterpriseNotificationsService({
      pool,
      sender,
      appName: "MegaUI",
      appUrl: "https://megaui.example.test/sign-in",
      locale: "en",
      now: () => new Date(currentNow.getTime()),
    });
  }

  it("reconciles a committed session exactly once per grant", async () => {
    const service = createService();
    const first = await service.reconcile();
    const replay = await service.reconcile();
    expect(first.inserted).toBe(5);
    expect(replay.inserted).toBe(0);

    const rows = await pool.query<{ count: string }>(
      `select count(*)::text as count from enterprise_notification_outbox
        where grant_id = $1`,
      [members.get(1)?.grantId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("reads only notification_email and renders the FS-31 template", async () => {
    const service = createService();
    const before = deliveries.length;
    const result = await service.deliver();
    expect(result.sent).toBe(4);
    expect(deliveries.length - before).toBe(4);
    const first = deliveries.find((delivery) => delivery.to === "notify1@example.test");
    expect(first?.to).toBe("notify1@example.test");
    expect(first?.params).toMatchObject({
      recipientName: "Display 1",
      device: "Chromium FS21/1",
      source: "203.0.113.*",
      appName: "MegaUI",
      appUrl: "https://megaui.example.test/sign-in",
      locale: "en",
    });
    expect(first?.params).not.toHaveProperty("email");
  });

  it("records a missing notification address as skipped", async () => {
    const row = await pool.query<{ state: string; destination_email: string | null; skipped_at: Date | null }>(
      `select state, destination_email, skipped_at from enterprise_notification_outbox where grant_id = $1`,
      [members.get(2)?.grantId],
    );
    expect(row.rows[0]).toMatchObject({ state: "skipped", destination_email: null });
    expect(row.rows[0]?.skipped_at).toBeInstanceOf(Date);
  });

  it("keeps the session when the sender fails", async () => {
    const service = createService();
    await seedMember(6, "notify6@example.test");
    await service.reconcile();
    senderShouldFail = true;
    const result = await service.deliver();
    senderShouldFail = false;
    expect(result.failed).toBe(1);
    const outbox = await pool.query<{ state: string; attempts: number }>(
      `select state, attempts from enterprise_notification_outbox where grant_id = $1`,
      [members.get(6)?.grantId],
    );
    expect(outbox.rows[0]).toMatchObject({ state: "failed", attempts: 1 });
    const session = await pool.query(`select id from session where enterprise_grant_id = $1`, [members.get(6)?.grantId]);
    expect(session.rows).toHaveLength(1);
  });

  it("invalidates a pending row when the destination version changes", async () => {
    const service = createService();
    await seedMember(7, "notify7@example.test");
    await service.reconcile();
    const before = await pool.query<{ state: string; destination_version: string }>(
      `select state, destination_version from enterprise_notification_outbox where grant_id = $1`,
      [members.get(7)?.grantId],
    );
    await pool.query(
      `update enterprise_profile set notification_email = 'replacement@example.test', updated_at = '2026-11-13T00:02:00.000Z' where user_id = $1`,
      [members.get(7)?.userId],
    );
    await service.reconcile();
    const after = await pool.query<{ state: string; destination_version: string; count: string }>(
      `select state, destination_version, count(*) over ()::text as count
         from enterprise_notification_outbox where grant_id = $1`,
      [members.get(7)?.grantId],
    );
    expect(before.rows[0]?.state).toBe("pending");
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.state).toBe("skipped");
    expect(after.rows[0]?.destination_version).toBe(before.rows[0]?.destination_version);
    expect(after.rows[0]?.count).toBe("1");
  });

  it("does not send a pending notification after identity offboarding", async () => {
    const service = createService();
    await seedMember(8, "notify8@example.test");
    await service.reconcile();
    await pool.query(`update enterprise_identity set status = 'resigned' where id = $1`, [members.get(8)?.identityId]);
    const before = deliveries.length;
    await service.reconcile();
    const result = await service.deliver();
    expect(result.sent).toBe(0);
    expect(deliveries.length).toBe(before);
    const row = await pool.query<{ state: string }>(
      `select state from enterprise_notification_outbox where grant_id = $1`,
      [members.get(8)?.grantId],
    );
    expect(row.rows[0]?.state).toBe("skipped");
  });

  it("schedules the next reconciliation exactly sixty seconds later", async () => {
    const calls: Array<{ values?: unknown[] }> = [];
    const writer = {
      async query(_text: string, values?: unknown[]) {
        calls.push({ values });
        return { rowCount: 1 };
      },
    };
    const fakeService = {
      reconcile: async () => ({ candidates: 0, inserted: 0, invalidated: 0, skipped: 0 }),
      deliver: async () => ({ sent: 0, failed: 0 }),
      reconcileAndDeliver: async () => ({ candidates: 0, inserted: 0, invalidated: 0, skipped: 0, sent: 0, failed: 0 }),
    };
    const handler = createEnterpriseNotificationJobHandler({ service: fakeService, writer });
    await handler({
      id: "fs21-job",
      queue: ENTERPRISE_NOTIFICATION_QUEUE,
      payload: { scheduledFor: "2026-11-13T00:01:00.000Z" },
    });
    expect(calls[0]?.values?.[3]).toBe(JSON.stringify({ scheduledFor: "2026-11-13T00:02:00.000Z" }));
  });
});
