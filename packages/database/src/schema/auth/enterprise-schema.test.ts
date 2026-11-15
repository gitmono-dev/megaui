// FS-02：企业身份与通知资料schema。
//
// The suite proves the constraints of the three new tables on a one-shot
// Postgres of FS-57. It never skips: without a docker daemon the run fails
// instead of pretending to have verified the schema.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";
import { assertMonotonicActivation } from "./enterprise-policy";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-schema.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

interface UserRow {
  id: string;
}

let isolated: IsolatedPostgres;
let pool: Pool;
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const id = `enterprise-schema-user-${userCounter}`;
  await pool.query(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, false)`,
    [id, `User ${userCounter}`, `user${userCounter}@example.com`],
  );
  return id;
}

async function insertIdentity(row: {
  id: string;
  localUserId: string;
  tenantKey: string;
  appId: string;
  openId: string;
  unionId?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_identity"
       (id, local_user_id, tenant_key, app_id, open_id, union_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [row.id, row.localUserId, row.tenantKey, row.appId, row.openId, row.unionId ?? null],
  );
}

async function insertProfile(row: {
  userId: string;
  tenantKey: string;
  loginName: string;
  backendUsername: string;
  notificationEmail?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_profile"
       (user_id, tenant_key, login_name, backend_username, notification_email)
     values ($1, $2, $3, $4, $5)`,
    [
      row.userId,
      row.tenantKey,
      row.loginName,
      row.backendUsername,
      row.notificationEmail ?? null,
    ],
  );
}

describe("enterprise identity, profile and policy schema (FS-02)", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (isolated) await isolated.destroy();
  }, 120_000);

  it("keeps the external identity triple unique", async () => {
    const localUserId = await createUser();
    await insertIdentity({
      id: "identity-triple-1",
      localUserId,
      tenantKey: "tenant_a",
      appId: "app_a",
      openId: "open_a",
    });

    await expect(
      insertIdentity({
        id: "identity-triple-2",
        localUserId: await createUser(),
        tenantKey: "tenant_a",
        appId: "app_a",
        openId: "open_a",
      }),
    ).rejects.toThrow(/enterprise_identity_tenant_app_open_uidx/);

    // The same open id of another app or another tenant is a different identity.
    await insertIdentity({
      id: "identity-triple-3",
      localUserId: await createUser(),
      tenantKey: "tenant_a",
      appId: "app_b",
      openId: "open_a",
    });
  });

  it("binds a local user id only once per app and tenant", async () => {
    const localUserId = await createUser();
    await insertIdentity({
      id: "identity-binding-1",
      localUserId,
      tenantKey: "tenant_b",
      appId: "app_a",
      openId: "open_binding_1",
    });

    await expect(
      insertIdentity({
        id: "identity-binding-2",
        localUserId,
        tenantKey: "tenant_b",
        appId: "app_a",
        openId: "open_binding_2",
      }),
    ).rejects.toThrow(/enterprise_identity_local_tenant_app_uidx/);

    // Another app of the same tenant may bind the same local user.
    await insertIdentity({
      id: "identity-binding-3",
      localUserId,
      tenantKey: "tenant_b",
      appId: "app_b",
      openId: "open_binding_3",
    });
  });

  it("keeps the login name unique inside the tenant", async () => {
    const first = await createUser();
    const second = await createUser();
    await insertProfile({
      userId: first,
      tenantKey: "tenant_c",
      loginName: "alice",
      backendUsername: "mgu_backend_alice",
    });

    await expect(
      insertProfile({
        userId: second,
        tenantKey: "tenant_c",
        loginName: "alice",
        backendUsername: "mgu_backend_alice_2",
      }),
    ).rejects.toThrow(/enterprise_profile_tenant_login_name_uidx/);

    // Another tenant may use the same alias.
    await insertProfile({
      userId: second,
      tenantKey: "tenant_d",
      loginName: "alice",
      backendUsername: "mgu_backend_alice_3",
    });
  });

  it("keeps the backend username unique inside the instance", async () => {
    const first = await createUser();
    const second = await createUser();
    await insertProfile({
      userId: first,
      tenantKey: "tenant_e",
      loginName: "backend-one",
      backendUsername: "mgu_backend_unique",
    });

    await expect(
      insertProfile({
        userId: second,
        tenantKey: "tenant_e",
        loginName: "backend-two",
        backendUsername: "mgu_backend_unique",
      }),
    ).rejects.toThrow(/enterprise_profile_backend_username_uidx/);
  });

  it("accepts a missing notification address and keeps it out of the identity", async () => {
    const first = await createUser();
    const second = await createUser();
    const third = await createUser();

    // A null notification address is allowed.
    await insertProfile({
      userId: first,
      tenantKey: "tenant_f",
      loginName: "notify-one",
      backendUsername: "mgu_backend_notify_one",
      notificationEmail: null,
    });

    // The same address may notify several identities.
    await insertProfile({
      userId: second,
      tenantKey: "tenant_f",
      loginName: "notify-two",
      backendUsername: "mgu_backend_notify_two",
      notificationEmail: "shared@example.com",
    });
    await insertProfile({
      userId: third,
      tenantKey: "tenant_f",
      loginName: "notify-three",
      backendUsername: "mgu_backend_notify_three",
      notificationEmail: "shared@example.com",
    });

    const rows = await pool.query<{ notification_email: string | null }>(
      `select notification_email from "enterprise_profile" where tenant_key = $1 order by login_name`,
      ["tenant_f"],
    );
    expect(rows.rows.map((row) => row.notification_email)).toEqual([
      null,
      "shared@example.com",
      "shared@example.com",
    ]);
  });

  it("refuses a login name that is not an ascii alias", async () => {
    await expect(
      insertProfile({
        userId: await createUser(),
        tenantKey: "tenant_g",
        loginName: "Alice Example",
        backendUsername: "mgu_backend_alias",
      }),
    ).rejects.toThrow(/enterprise_profile_login_name_format_check/);
  });

  it("persists the instance ownership and the activation state of the policy", async () => {
    await pool.query(
      `insert into "enterprise_policy"
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        "policy-1",
        "instance",
        "owner-fingerprint-1",
        "test",
        "test",
        3,
        "enterprise",
      ],
    );

    const stored = await pool.query<{
      owner_fingerprint: string;
      auth_epoch: number;
      activation_state: string;
      activated_at: Date | null;
    }>(`select owner_fingerprint, auth_epoch, activation_state, activated_at from "enterprise_policy" where id = $1`, [
      "policy-1",
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.owner_fingerprint).toBe("owner-fingerprint-1");
    expect(stored.rows[0]?.auth_epoch).toBe(3);
    expect(stored.rows[0]?.activation_state).toBe("enterprise");
  });

  it("keeps the activation state and its watermark monotonic", async () => {
    // An unknown activation state is refused.
    await expect(
      pool.query(
        `insert into "enterprise_policy"
           (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        ["policy-2", "instance-2", "owner-fingerprint-2", "test", "test", 1, "activated"],
      ),
    ).rejects.toThrow(/enterprise_policy_activation_state_check/);

    // A negative watermark is refused.
    await expect(
      pool.query(
        `insert into "enterprise_policy"
           (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        ["policy-3", "instance-3", "owner-fingerprint-3", "test", "test", -1, "maintenance"],
      ),
    ).rejects.toThrow(/enterprise_policy_auth_epoch_check/);

    // A legacy deployment was never activated, so its watermark is zero.
    await expect(
      pool.query(
        `insert into "enterprise_policy"
           (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        ["policy-4", "instance-4", "owner-fingerprint-4", "test", "test", 2, "legacy"],
      ),
    ).rejects.toThrow(/enterprise_policy_legacy_epoch_check/);

    // An activated deployment may not present itself as legacy: the row
    // carries a watermark, and legacy means the watermark zero.
    await expect(
      pool.query(
        `insert into "enterprise_policy"
           (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        ["policy-5", "instance-5", "owner-fingerprint-5", "test", "test", 2, "legacy"],
      ),
    ).rejects.toThrow(/enterprise_policy_legacy_epoch_check/);

    // A deployment that was never activated may enter maintenance with the
    // watermark zero, and it may leave legacy for it.
    await pool.query(
      `insert into "enterprise_policy"
         (id, scope, owner_fingerprint, deployment_role, environment, auth_epoch, activation_state)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ["policy-6", "instance-6", "owner-fingerprint-6", "test", "test", 0, "legacy"],
    );
    await pool.query(
      `update "enterprise_policy" set auth_epoch = $1, activation_state = $2 where id = $3`,
      [1, "maintenance", "policy-6"],
    );

    const stored = await pool.query<{ auth_epoch: number; activation_state: string }>(
      `select auth_epoch, activation_state from "enterprise_policy" where id = $1`,
      ["policy-6"],
    );
    expect(stored.rows[0]?.auth_epoch).toBe(1);
    expect(stored.rows[0]?.activation_state).toBe("maintenance");
  });

  it("refuses an activation that would move the watermark backwards", () => {
    const activated = { authEpoch: 3, activationState: "enterprise" as const };

    expect(() =>
      assertMonotonicActivation(activated, { authEpoch: 2, activationState: "enterprise" }),
    ).toThrow(/watermark may not decrease/);
    expect(() =>
      assertMonotonicActivation(activated, { authEpoch: 3, activationState: "legacy" }),
    ).toThrow(/may not return to legacy/);

    // Repairing an activated deployment into maintenance keeps the watermark.
    expect(() =>
      assertMonotonicActivation(activated, { authEpoch: 3, activationState: "maintenance" }),
    ).not.toThrow();
    expect(() =>
      assertMonotonicActivation(activated, { authEpoch: 4, activationState: "enterprise" }),
    ).not.toThrow();
  });

  it("keeps every enterprise row bound to an existing local user", async () => {
    await expect(
      insertIdentity({
        id: "identity-orphan",
        localUserId: "does-not-exist",
        tenantKey: "tenant_h",
        appId: "app_a",
        openId: "open_orphan",
      }),
    ).rejects.toThrow(/enterprise_identity_local_user_id_user_id_fk/);

    await expect(
      insertProfile({
        userId: "does-not-exist",
        tenantKey: "tenant_h",
        loginName: "orphan",
        backendUsername: "mgu_backend_orphan",
      }),
    ).rejects.toThrow(/enterprise_profile_user_id_user_id_fk/);
  });
});
