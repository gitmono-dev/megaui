// FS-43：管理员操作与迁移账本 schema。
//
// The suite proves the constraints of the three new tables on a one-shot
// Postgres of FS-57. It never skips: without a docker daemon the run fails
// instead of pretending to have verified the schema.
import { getTableColumns } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "../../test-support/isolated-pg";
import { enterpriseAdminOperations } from "./enterprise-operations";

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  throw new Error(
    "[@megaui/database] enterprise-operations.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

let isolated: IsolatedPostgres;
let pool: Pool;
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const id = `enterprise-operations-user-${userCounter}`;
  await pool.query(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, false)`,
    [id, `User ${userCounter}`, `operations-user${userCounter}@example.com`],
  );
  return id;
}

async function insertOperation(row: {
  id: string;
  operationId: string;
  verb?: string;
  manifestDigest?: string;
  expectedUserVersion?: number | null;
  expectedIdentityVersion?: number | null;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_admin_operations"
       (id, operation_id, verb, manifest_digest, expected_user_version, expected_identity_version)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      row.id,
      row.operationId,
      row.verb ?? "provision",
      row.manifestDigest ?? "digest-1",
      row.expectedUserVersion ?? null,
      row.expectedIdentityVersion ?? null,
    ],
  );
}

describe("enterprise operation, checkpoint and quarantine schema (FS-43)", () => {
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

  it("deduplicates an administrative operation by its operation id", async () => {
    await insertOperation({ id: "operation-1", operationId: "op-1" });
    await expect(
      insertOperation({ id: "operation-2", operationId: "op-1" }),
    ).rejects.toThrow(/enterprise_admin_operations_operation_id_uidx/);

    // Another operation id is another operation.
    await insertOperation({ id: "operation-3", operationId: "op-2" });
  });

  it("binds a batch checkpoint to the manifest digest", async () => {
    await insertOperation({ id: "operation-4", operationId: "op-3" });
    await pool.query(
      `insert into "enterprise_batch_checkpoints" (id, operation_id, manifest_digest, batch_number)
       values ($1, $2, $3, $4)`,
      ["checkpoint-1", "op-3", "digest-1", 1],
    );

    // The same batch of the same operation is a unique checkpoint.
    await expect(
      pool.query(
        `insert into "enterprise_batch_checkpoints" (id, operation_id, manifest_digest, batch_number)
         values ($1, $2, $3, $4)`,
        ["checkpoint-2", "op-3", "digest-1", 1],
      ),
    ).rejects.toThrow(/enterprise_batch_checkpoints_operation_batch_uidx/);

    // The digest of a checkpoint is readable and belongs to its operation.
    const stored = await pool.query<{ manifest_digest: string }>(
      `select manifest_digest from "enterprise_batch_checkpoints" where id = $1`,
      ["checkpoint-1"],
    );
    expect(stored.rows[0]?.manifest_digest).toBe("digest-1");
  });

  it("keeps the quarantine a persistent user state", async () => {
    const userId = await createUser();
    await pool.query(
      `insert into "enterprise_quarantine" (id, user_id, reason) values ($1, $2, $3)`,
      ["quarantine-1", userId, "empty actor"],
    );

    // The user carries one quarantine.
    await expect(
      pool.query(
        `insert into "enterprise_quarantine" (id, user_id, reason) values ($1, $2, $3)`,
        ["quarantine-2", userId, "another reason"],
      ),
    ).rejects.toThrow(/enterprise_quarantine_user_id_uidx/);

    // The state survives: it is a row, not a note in a log.
    const stored = await pool.query<{ state: string; reason: string }>(
      `select state, reason from "enterprise_quarantine" where user_id = $1`,
      [userId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.state).toBe("quarantined");
    expect(stored.rows[0]?.reason).toBe("empty actor");
  });

  it("keeps the expected versions in the audit of an operation", async () => {
    await insertOperation({
      id: "operation-5",
      operationId: "op-4",
      expectedUserVersion: 7,
      expectedIdentityVersion: 3,
    });

    const stored = await pool.query<{
      expected_user_version: number;
      expected_identity_version: number;
    }>(
      `select expected_user_version, expected_identity_version
         from "enterprise_admin_operations" where operation_id = $1`,
      ["op-4"],
    );
    expect(stored.rows[0]?.expected_user_version).toBe(7);
    expect(stored.rows[0]?.expected_identity_version).toBe(3);
  });

  it("never stores a verification code in the audit", () => {
    const columns = Object.keys(getTableColumns(enterpriseAdminOperations)).map(
      (name) => name.toLowerCase(),
    );
    for (const forbidden of ["code", "otp", "verification_code", "challenge"]) {
      expect(columns).not.toContain(forbidden);
    }
    // The audit keeps counts and digests, not secrets.
    expect(columns).toContain("manifestdigest");
    expect(columns).toContain("expecteduserversion");
  });
});
