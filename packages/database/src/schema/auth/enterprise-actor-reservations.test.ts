// FS-69：后端 actor 保留集 schema。
//
// The suite proves the constraints of the reservation table on a one-shot
// Postgres of FS-57. It never skips: without a docker daemon the run fails
// instead of pretending to have verified the schema.
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
    "[@megaui/database] enterprise-actor-reservations.test.ts: a docker daemon is required (the fixture owns its own Postgres).",
  );
}

let isolated: IsolatedPostgres;
let pool: Pool;
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const id = `reservation-user-${userCounter}`;
  await pool.query(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, false)`,
    [id, `User ${userCounter}`, `reservation-user${userCounter}@example.com`],
  );
  return id;
}

async function insertReservation(row: {
  id: string;
  backendUsername: string;
  actorState?: string;
  localUserId?: string | null;
  identityId?: string | null;
  quarantined?: boolean;
  digest?: string;
}): Promise<void> {
  await pool.query(
    `insert into "enterprise_actor_reservations"
       (id, backend_username, actor_state, local_user_id, identity_id, quarantined, source_snapshot_digest)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.id,
      row.backendUsername,
      row.actorState ?? "reserved",
      row.localUserId ?? null,
      row.identityId ?? null,
      row.quarantined ?? false,
      row.digest ?? "snapshot-digest-1",
    ],
  );
}

describe("enterprise actor reservation schema (FS-69)", () => {
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

  it("keeps the actor key unique in the instance", async () => {
    await insertReservation({ id: "reservation-1", backendUsername: "mgu_actor_one" });
    await expect(
      insertReservation({ id: "reservation-2", backendUsername: "mgu_actor_one" }),
    ).rejects.toThrow(/enterprise_actor_reservations_backend_username_uidx/);

    await insertReservation({ id: "reservation-3", backendUsername: "mgu_actor_two" });
  });

  it("allows a reservation without a current identity", async () => {
    await insertReservation({
      id: "reservation-4",
      backendUsername: "mgu_actor_unbound",
      identityId: null,
      localUserId: null,
    });

    const stored = await pool.query<{ identity_id: string | null; local_user_id: string | null }>(
      `select identity_id, local_user_id from "enterprise_actor_reservations" where id = $1`,
      ["reservation-4"],
    );
    expect(stored.rows[0]?.identity_id).toBeNull();
    expect(stored.rows[0]?.local_user_id).toBeNull();
  });

  it("never releases the actor of a quarantined subject", async () => {
    const userId = await createUser();
    await insertReservation({
      id: "reservation-5",
      backendUsername: "mgu_actor_quarantined",
      localUserId: userId,
      quarantined: true,
    });

    // A quarantined subject cannot be registered in another state.
    await expect(
      pool.query(
        `insert into "enterprise_actor_reservations"
           (id, backend_username, actor_state, quarantined, source_snapshot_digest)
         values ($1, $2, $3, $4, $5)`,
        ["reservation-6", "mgu_actor_quarantine_2", "ambiguous", true, "snapshot-digest-1"],
      ),
    ).rejects.toThrow(/enterprise_actor_reservations_quarantine_check/);

    const stored = await pool.query<{ actor_state: string }>(
      `select actor_state from "enterprise_actor_reservations" where id = $1`,
      ["reservation-5"],
    );
    expect(stored.rows[0]?.actor_state).toBe("reserved");
  });

  it("registers an upstream native actor as unclaimable", async () => {
    await insertReservation({
      id: "reservation-7",
      backendUsername: "mgu_actor_native",
      actorState: "unclaimable",
    });

    const stored = await pool.query<{ actor_state: string }>(
      `select actor_state from "enterprise_actor_reservations" where id = $1`,
      ["reservation-7"],
    );
    expect(stored.rows[0]?.actor_state).toBe("unclaimable");
  });

  it("marks several historical subjects that share a name as ambiguous", async () => {
    await insertReservation({
      id: "reservation-8",
      backendUsername: "mgu_actor_shared_name",
      actorState: "ambiguous",
    });

    const stored = await pool.query<{ actor_state: string }>(
      `select actor_state from "enterprise_actor_reservations" where id = $1`,
      ["reservation-8"],
    );
    expect(stored.rows[0]?.actor_state).toBe("ambiguous");
  });

  it("stores the digest of the source snapshot", async () => {
    await insertReservation({
      id: "reservation-9",
      backendUsername: "mgu_actor_snapshot",
      digest: "snapshot-digest-9",
    });

    const stored = await pool.query<{ source_snapshot_digest: string }>(
      `select source_snapshot_digest from "enterprise_actor_reservations" where id = $1`,
      ["reservation-9"],
    );
    expect(stored.rows[0]?.source_snapshot_digest).toBe("snapshot-digest-9");

    // A reservation without a source snapshot is refused.
    await expect(
      pool.query(
        `insert into "enterprise_actor_reservations" (id, backend_username, source_snapshot_digest)
         values ($1, $2, $3)`,
        ["reservation-10", "mgu_actor_no_snapshot", null],
      ),
    ).rejects.toThrow(/null value in column "source_snapshot_digest"/);
  });
});
