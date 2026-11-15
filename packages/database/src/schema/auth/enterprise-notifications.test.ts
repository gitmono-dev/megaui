// FS-55：通知 outbox schema。
//
// This suite owns a real, one-shot Postgres and deliberately fails when the
// Docker fixture is unavailable.  It proves the durable idempotency key,
// destination-version snapshot, template-only payload and bounded cleanup.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-notifications.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

let isolated: IsolatedPostgres;
let pool: Pool;

const FIXED_CREATED_AT = "2026-11-13T00:00:00.000Z";
const FIXED_EXPIRES_AT = "2026-12-01T00:00:00.000Z";
const GRANT_ID = "11111111-1111-4111-8111-111111111111";

async function seedGrant(): Promise<void> {
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ('fs55-user', 'FS55 User', 'fs55-user@example.test', false)`,
  );
  await pool.query(
    `insert into enterprise_policy
       (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
     values ('fs55-policy', 'fs55-scope', '${"a".repeat(64)}', 'test', 'test', 1, 'enterprise')`,
  );
  await pool.query(
    `insert into enterprise_identity
       (id, local_user_id, tenant_key, app_id, open_id, identity_version)
     values ('fs55-identity', 'fs55-user', 'fs55-tenant', 'fs55-app', 'fs55-open', 1)`,
  );
  await pool.query(
    `insert into enterprise_challenges
       (id, scope, deployment_role, local_user_id, identity_id, identity_version,
        flow_hash, generation, purpose, state, failed_attempts, created_at,
        expires_at, secret_expires_at, code_hmac, hmac_key_id)
     values
       ('22222222-2222-4222-8222-222222222222', 'fs55-scope', 'test',
        'fs55-user', 'fs55-identity', 1, '${"b".repeat(64)}', 1, 'login',
        'active', 0, '${FIXED_CREATED_AT}', '2026-11-13T00:05:00.000Z',
        '2026-11-13T00:05:00.000Z', '${"c".repeat(64)}', 'fs55-key')`,
  );
  await pool.query(
    `insert into enterprise_login_grants
       (id, challenge_id, scope, deployment_role, local_user_id, identity_id,
        identity_version, auth_epoch, flow_hash, generation, purpose,
        created_at, recover_until)
     values
       ($1, '22222222-2222-4222-8222-222222222222', 'fs55-scope', 'test',
        'fs55-user', 'fs55-identity', 1, 1, $2, 1, 'login',
        $3, '2026-11-13T00:03:00.000Z')`,
    [GRANT_ID, "b".repeat(64), FIXED_CREATED_AT],
  );

  for (let index = 2; index <= 8; index += 1) {
    const suffix = index.toString(16).padStart(2, "0");
    const challengeId = `00000000-0000-4000-8000-${suffix.repeat(6)}`;
    const grantSuffix = (index + 10).toString(16).padStart(2, "0");
    const grantId = `00000000-0000-4000-8000-${grantSuffix.repeat(6)}`;
    const flowHash = index.toString(16).repeat(64).slice(0, 64);
    await pool.query(
      `insert into enterprise_challenges
         (id, scope, deployment_role, local_user_id, identity_id, identity_version,
          flow_hash, generation, purpose, state, failed_attempts, created_at,
          expires_at, secret_expires_at, code_hmac, hmac_key_id)
       values ($1, 'fs55-scope', 'test', 'fs55-user', 'fs55-identity', 1,
         $2, $3, 'login', 'active', 0, $4, $5, $5, $6, 'fs55-key')`,
      [
        challengeId,
        flowHash,
        index,
        FIXED_CREATED_AT,
        "2026-11-13T00:05:00.000Z",
        "d".repeat(64),
      ],
    );
    await pool.query(
      `insert into enterprise_login_grants
         (id, challenge_id, scope, deployment_role, local_user_id, identity_id,
          identity_version, auth_epoch, flow_hash, generation, purpose,
          created_at, recover_until)
       values ($1, $2, 'fs55-scope', 'test', 'fs55-user', 'fs55-identity',
         1, 1, $3, $4, 'login', $5, '2026-11-13T00:03:00.000Z')`,
      [grantId, challengeId, flowHash, index, FIXED_CREATED_AT],
    );
  }
}

async function insertNotification(input: {
  id: string;
  grantId?: string;
  destinationVersion?: string;
  state?: string;
  expiresAt?: string;
  createdAt?: string;
  appUrl?: string;
  sentAt?: string | null;
  skippedAt?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into enterprise_notification_outbox
       (id, grant_id, destination_email, destination_version, recipient_name,
        login_at, device, source, app_name, app_url, locale, state, attempts,
        available_at, sent_at, skipped_at, expires_at, created_at)
     values ($1, $2, 'notify@example.test', $3, 'FS55 User', $4,
       'Chromium on macOS', '203.0.113.*', 'MegaUI', $5, 'en', $6, 0,
       $4, $7, $8, $9, $4)`,
    [
      input.id,
      input.grantId ?? GRANT_ID,
      input.destinationVersion ?? "2026-11-13T00:00:00.000Z",
      input.createdAt ?? FIXED_CREATED_AT,
      input.appUrl ?? "https://megaui.example.test/sign-in",
      input.state ?? "pending",
      input.sentAt ?? null,
      input.skippedAt ?? null,
      input.expiresAt ?? FIXED_EXPIRES_AT,
    ],
  );
}

describe("enterprise notification outbox schema (FS-55)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    await seedGrant();
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("allows at most one login notification for a grant", async () => {
    await insertNotification({ id: "33333333-3333-4333-8333-333333333333" });

    await expect(
      insertNotification({ id: "44444444-4444-4444-8444-444444444444" }),
    ).rejects.toThrow(/enterprise_notification_outbox_grant_uidx/);

    const indexes = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'enterprise_notification_outbox'
         and indexname = 'enterprise_notification_outbox_grant_uidx'`,
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toContain("grant_id");
  });

  it("persists the destination version and template fields", async () => {
    const row = await pool.query<{
      destination_version: string;
      destination_email: string;
      recipient_name: string;
      device: string;
      source: string;
      app_url: string;
    }>(
      `select destination_version, destination_email, recipient_name, device, source, app_url
         from enterprise_notification_outbox where grant_id = $1`,
      [GRANT_ID],
    );
    expect(row.rows[0]).toEqual({
      destination_version: "2026-11-13T00:00:00.000Z",
      destination_email: "notify@example.test",
      recipient_name: "FS55 User",
      device: "Chromium on macOS",
      source: "203.0.113.*",
      app_url: "https://megaui.example.test/sign-in",
    });
  });

  it("has no OTP, session-token or secret-bearing columns", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'enterprise_notification_outbox'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/otp|token|secret/i),
    ]));
  });

  it("rejects auth-shaped links and keeps terminal state metadata coherent", async () => {
    await expect(
      insertNotification({
        id: "55555555-5555-4555-8555-555555555555",
        grantId: "00000000-0000-4000-8000-0c0c0c0c0c0c",
        appUrl: "https://megaui.example.test/sign-in?token=secret",
      }),
    ).rejects.toThrow(/enterprise_notification_outbox_fields_check/);

    await expect(
      insertNotification({
        id: "66666666-6666-4666-8666-666666666666",
        grantId: "00000000-0000-4000-8000-0d0d0d0d0d0d",
        state: "sent",
      }),
    ).rejects.toThrow(/enterprise_notification_outbox_terminal_check/);

    await insertNotification({
      id: "77777777-7777-4777-8777-777777777777",
      grantId: "00000000-0000-4000-8000-0e0e0e0e0e0e",
      state: "sent",
      sentAt: "2026-11-13T00:01:00.000Z",
    });
    await insertNotification({
      id: "88888888-8888-4888-8888-888888888888",
      grantId: "00000000-0000-4000-8000-0f0f0f0f0f0f",
      state: "skipped",
      skippedAt: "2026-11-13T00:01:00.000Z",
    });
  });

  it("supports bounded expiry cleanup", async () => {
    await insertNotification({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      grantId: "00000000-0000-4000-8000-101010101010",
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-02T00:00:00.000Z",
    });
    const indexes = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'enterprise_notification_outbox'
         and indexname = 'enterprise_notification_outbox_expires_at_idx'`,
    );
    expect(indexes.rows[0]?.indexdef).toContain("expires_at");

    const deleted = await pool.query(
      `delete from enterprise_notification_outbox
         where expires_at < $1
         returning id`,
      ["2026-11-01T00:00:00.000Z"],
    );
    expect(deleted.rowCount).toBe(1);
    expect(deleted.rows[0]?.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});
