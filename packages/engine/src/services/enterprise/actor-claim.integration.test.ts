// FS-71: real, run-owned PostgreSQL; directory authority is an injected FS-10 reader.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { createPostgresAuthenticationEligibilityReader } from "./eligibility";
import { checkActorReservationCoverage, runActorReservationMutation } from "./actor-reservations";
import { createActorClaimService, type NewActorSubject } from "./actor-claim";

const SCOPE = "fs71-instance";
const TENANT = "fs71-tenant";
const APP = "fs71-app";
const REQUEST = { localUserId: "new-subject", openId: "ou-new", loginName: "new.alias" };
const backend = (id: string) => "mgu_" + createHash("sha256").update(id).digest("hex").slice(0, 32);

describe("actor admission and atomic inventory delta (FS-71)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let now: number;
  let admitted: boolean;
  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

  async function transaction<T>(fn: (client: PoolClient) => Promise<T>, commitCaughtError = false): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      // A caller catching a service rejection must not accidentally commit its partial creation.
      await client.query(commitCaughtError ? "commit" : "rollback");
      throw error;
    } finally { client.release(); }
  }

  async function createSubject(client: PoolClient, input: NewActorSubject): Promise<void> {
    await client.query('insert into "user" (id, name, email, email_verified) values ($1,$2,$3,false)',
      [input.localUserId, "New Person", input.localUserId + "@identity.invalid"]);
    await client.query("insert into enterprise_profile (user_id, tenant_key, login_name, backend_username) values ($1,$2,$3,$4)",
      [input.localUserId, input.tenantKey, input.loginName, input.backendUsername]);
    await client.query("insert into enterprise_identity (id, local_user_id, tenant_key, app_id, open_id) values ($1,$2,$3,$4,$5)",
      ["identity-" + input.localUserId, input.localUserId, input.tenantKey, input.appId, input.openId]);
  }

  function configuration(creator = createSubject): Parameters<typeof createActorClaimService>[0] {
    return {
      eligibility: {
        policyScope: SCOPE, authMode: "enterprise",
        directoryScope: { tenantKey: TENANT, appId: APP, departmentIds: ["approved"] },
        databaseReader: createPostgresAuthenticationEligibilityReader(pool),
        directoryReader: { tenantKey: TENANT, appId: APP, async read(openId) {
          return { openId, departmentIds: [admitted ? "approved" : "outside"],
            status: { isActivated: true, isFrozen: false, isResigned: false, isExited: false } };
        } },
        now: () => new Date(now),
      },
      createSubject: creator,
    };
  }
  function service(creator = createSubject) {
    return createActorClaimService(configuration(creator));
  }

  async function seal(actors = [{ actor: "native", owners: ["upstream-owner"] }]) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, observedAt: new Date(now - 10_000).toISOString(), actors }));
    await transaction(client => runActorReservationMutation({
      verb: "reserve-actors", operationId: randomUUID(),
      args: { target: SCOPE, digest: createHash("sha256").update(bytes).digest("hex") },
      files: { names: () => ["upstream"], bytes: () => bytes },
    }, client));
  }

  async function inventory() { return (await pool.query("select * from enterprise_actor_inventory")).rows[0]; }
  async function coverage() {
    return transaction(client => checkActorReservationCoverage(client, { scope: SCOPE, now: new Date(now) }));
  }
  async function assertNoNewSubject() {
    for (const [table, column] of [["user", "id"], ["enterprise_profile", "user_id"],
      ["enterprise_identity", "local_user_id"], ["enterprise_actor_reservations", "local_user_id"]]) {
      expect((await pool.query(`select count(*)::int as count from "${table}" where ${column} = $1`, [REQUEST.localUserId])).rows[0]?.count).toBe(0);
    }
  }

  async function waitForLock(pid: number) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock") return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("expected a real PostgreSQL lock wait");
  }

  function afterQuery(client: PoolClient, hook: (sql: string) => Promise<void>): PoolClient {
    return new Proxy(client, { get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.query, target, args);
        if (typeof args[0] === "string") await hook(args[0]);
        return result;
      };
    } });
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);
  beforeEach(async () => {
    now = Date.now(); admitted = true;
    await pool.query('delete from enterprise_actor_inventory; delete from enterprise_actor_reservations; ' +
      'delete from enterprise_batch_checkpoints; delete from enterprise_quarantine; delete from "user"; delete from enterprise_policy');
    await pool.query("insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
      "values ('policy',$1,'megaui','test','test',3,'enterprise')", [SCOPE]);
    await pool.query('insert into "user" (id,name,email,email_verified) values (\'legacy\',\'legacyactor\',\'legacy@example.test\',false)');
    await seal();
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-71 fixture cleanup failed");
  });

  scenario("creates the exact binding and actor while sealing only the new local delta", async () => {
    const before = await inventory();
    const result = await transaction(client => service().provision(client, REQUEST));
    expect(result).toEqual({ localUserId: REQUEST.localUserId, identityId: "identity-new-subject", backendUsername: backend(REQUEST.localUserId) });
    const after = await inventory();
    expect(after).toMatchObject({ operation_id: before.operation_id, source_digest: before.source_digest,
      observed_at: before.observed_at, upstream_actors: before.upstream_actors });
    expect(after.subjects_digest).not.toBe(before.subjects_digest);
    expect(after.ownership_digest).not.toBe(before.ownership_digest);
    expect(await coverage()).toMatchObject({ complete: true, missingUserIds: [], staleActors: [] });
    expect(await transaction(client => checkActorReservationCoverage(client, { scope: SCOPE, now: new Date(now),
      expectedOwnershipDigest: before.ownership_digest }))).toMatchObject({ complete: false, ownershipMatches: false });
    expect((await pool.query("select identity_id,source_snapshot_digest,source_observed_at from enterprise_actor_reservations where local_user_id=$1", [REQUEST.localUserId])).rows[0])
      .toEqual({ identity_id: result.identityId, source_snapshot_digest: before.source_digest, source_observed_at: before.observed_at });
  });

  scenario("allows approved empty inventory but never an unsealed empty database", async () => {
    await pool.query('delete from enterprise_actor_inventory; delete from enterprise_actor_reservations; delete from "user"');
    await expect(transaction(client => service().provision(client, REQUEST))).rejects.toThrow("ACTOR_INVENTORY_REJECTED");
    await seal([]);
    await transaction(client => service().provision(client, REQUEST));
    expect(await coverage()).toMatchObject({ complete: true });
  });

  scenario("requires persistent enterprise activation and authoritative membership before creation", async () => {
    let creations = 0;
    const claim = service(async (client, input) => { creations++; await createSubject(client, input); });
    for (const state of ["legacy", "maintenance"]) {
      await pool.query("update enterprise_policy set activation_state=$1,auth_epoch=$2", [state, state === "legacy" ? 0 : 3]);
      await expect(transaction(client => claim.provision(client, REQUEST))).rejects.toThrow("ENTERPRISE_ACTIVATION_REQUIRED");
    }
    await pool.query("update enterprise_policy set activation_state='enterprise',auth_epoch=3");
    admitted = false;
    await expect(transaction(client => claim.provision(client, REQUEST))).rejects.toThrow("DIRECTORY_ADMISSION_REJECTED");
    expect(creations).toBe(0);
    await assertNoNewSubject();
  });

  scenario("rejects a missing policy and an existing local id without replacing the subject", async () => {
    await expect(transaction(client => service().provision(client, { ...REQUEST, localUserId: "legacy" })))
      .rejects.toThrow("ACTOR_CLAIM_REJECTED");
    expect((await pool.query('select name,email from "user" where id=\'legacy\'')).rows[0])
      .toEqual({ name: "legacyactor", email: "legacy@example.test" });
    await pool.query("delete from enterprise_actor_inventory; delete from enterprise_policy");
    await expect(transaction(client => service().provision(client, REQUEST))).rejects.toThrow("ENTERPRISE_ACTIVATION_REQUIRED");
    await assertNoNewSubject();
  });

  scenario("keeps factory authority fixed after the supplied configuration changes", async () => {
    const options = configuration();
    const claim = createActorClaimService(options);
    options.eligibility.policyScope = "wrong-scope";
    options.eligibility.directoryScope.tenantKey = "wrong-tenant";
    options.eligibility.directoryScope.appId = "wrong-app";
    options.eligibility.directoryScope.departmentIds = ["outside"];
    options.eligibility.directoryReader.read = async () => { throw new Error("replaced reader must not run"); };
    options.createSubject = async () => { throw new Error("replaced writer must not run"); };
    await transaction(client => claim.provision(client, REQUEST));
    expect((await pool.query("select tenant_key,app_id,open_id from enterprise_identity where local_user_id=$1", [REQUEST.localUserId])).rows[0])
      .toEqual({ tenant_key: TENANT, app_id: APP, open_id: REQUEST.openId });
  });

  scenario("copies approved request fields before awaiting directory authority", async () => {
    const request = { ...REQUEST };
    const options = configuration();
    const originalRead = options.eligibility.directoryReader.read;
    options.eligibility.directoryReader.read = async openId => {
      await Promise.resolve();
      request.localUserId = "swapped-id"; request.openId = "swapped-open"; request.loginName = "swapped.alias";
      return originalRead(openId);
    };
    const result = await transaction(client => createActorClaimService(options).provision(client, request));
    expect(result.localUserId).toBe(REQUEST.localUserId);
    expect((await pool.query("select login_name from enterprise_profile where user_id=$1", [REQUEST.localUserId])).rows[0]?.login_name)
      .toBe(REQUEST.loginName);
  });

  scenario("fails directory exceptions and inactive authoritative members closed", async () => {
    const options = configuration();
    options.eligibility.directoryReader.read = async () => { throw new Error("private provider fixture detail"); };
    await expect(transaction(client => createActorClaimService(options).provision(client, REQUEST)))
      .rejects.toThrow("DIRECTORY_ADMISSION_REJECTED");
    options.eligibility.directoryReader.read = async openId => ({ openId, departmentIds: ["approved"],
      status: { isActivated: true, isFrozen: true, isResigned: false, isExited: false } });
    await expect(transaction(client => createActorClaimService(options).provision(client, REQUEST)))
      .rejects.toThrow("DIRECTORY_ADMISSION_REJECTED");
    await assertNoNewSubject();
  });

  scenario("rejects expired or drifted coverage before running the creation step", async () => {
    const before = await inventory();
    now = before.observed_at.getTime() + 86_400_001;
    await expect(transaction(client => service().provision(client, REQUEST))).rejects.toThrow("ACTOR_INVENTORY_REJECTED");
    now = before.observed_at.getTime() + 10_000;
    await pool.query('insert into "user" (id,name,email,email_verified) values (\'outside\',\'outside\',\'outside@example.test\',false)');
    await expect(transaction(client => service().provision(client, REQUEST))).rejects.toThrow("ACTOR_INVENTORY_REJECTED");
    expect(await inventory()).toEqual(before);
    await assertNoNewSubject();
  });

  scenario("rejects aliases reserved by historical and upstream owners and generated actor collisions", async () => {
    for (const loginName of ["legacyactor", "native"]) {
      await expect(transaction(client => service().provision(client, { ...REQUEST, loginName }))).rejects.toThrow("ACTOR_CLAIM_REJECTED");
    }
    await seal([{ actor: backend(REQUEST.localUserId), owners: ["upstream-owner"] }]);
    await expect(transaction(client => service().provision(client, REQUEST))).rejects.toThrow("ACTOR_CLAIM_REJECTED");
    await assertNoNewSubject();
  });

  scenario("reads only the explicit existing owner under maintenance and never releases quarantine", async () => {
    await pool.query("insert into enterprise_quarantine (id,user_id,reason) values ('q','legacy','fixture')");
    await seal();
    await pool.query("update enterprise_policy set activation_state='maintenance'");
    const before = await inventory();
    const claim = service();
    expect(await transaction(client => claim.existingOwner(client, "legacy")))
      .toEqual({ backendUsername: "legacyactor", quarantined: true });
    expect(await transaction(client => claim.existingOwner(client, "someone-else"))).toBeUndefined();
    expect(await inventory()).toEqual(before);
    expect((await pool.query("select state from enterprise_quarantine where user_id='legacy'")).rows[0]?.state).toBe("quarantined");
  });

  scenario("never treats ambiguous or owner-deleted reservations as claimable", async () => {
    await pool.query('insert into "user" (id,name,email,email_verified) values (\'duplicate\',\'legacyactor\',\'duplicate@example.test\',false)');
    await seal();
    expect(await transaction(client => service().existingOwner(client, "legacy"))).toBeUndefined();
    await pool.query('delete from "user" where id in (\'legacy\',\'duplicate\')');
    await seal();
    await expect(transaction(client => service().provision(client, { ...REQUEST, loginName: "legacyactor" }))).rejects.toThrow("ACTOR_CLAIM_REJECTED");
  });

  scenario("rolls back creation errors even when the caller catches and commits", async () => {
    const before = await inventory();
    const claim = service(async (client, input) => { await createSubject(client, input); throw new Error("synthetic creation failure"); });
    await expect(transaction(client => claim.provision(client, REQUEST), true)).rejects.toThrow("synthetic creation failure");
    expect(await inventory()).toEqual(before);
    await assertNoNewSubject();
  });

  for (const table of ["enterprise_actor_reservations", "enterprise_actor_inventory"]) {
    scenario("rolls back all account and inventory writes when " + table + " fails", async () => {
      const before = await inventory();
      await pool.query("create function fs71_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic claim write failure'; end $$");
      await pool.query(`create trigger fs71_failure before insert or update on ${table} for each row execute function fs71_failure()`);
      try {
        await expect(transaction(client => service().provision(client, REQUEST), true)).rejects.toThrow("synthetic claim write failure");
        expect(await inventory()).toEqual(before);
        await assertNoNewSubject();
      } finally {
        await pool.query(`drop trigger fs71_failure on ${table}`);
        await pool.query("drop function fs71_failure()");
      }
    });
  }

  scenario("rejects a creation callback that writes the wrong binding", async () => {
    const claim = service((client, input) => createSubject(client, { ...input, openId: "ou-wrong" }));
    await expect(transaction(client => claim.provision(client, REQUEST), true)).rejects.toThrow("ACTOR_CREATION_MISMATCH");
    await assertNoNewSubject();
  });

  scenario("does not seal an unrelated subject committed concurrently during creation", async () => {
    const before = await inventory();
    const claim = service(async (client, input) => {
      await createSubject(client, input);
      await pool.query('insert into "user" (id,name,email,email_verified) values (\'concurrent\',\'Concurrent\',\'concurrent@example.test\',false)');
    });
    await expect(transaction(client => claim.provision(client, REQUEST), true)).rejects.toThrow("ACTOR_INVENTORY_REJECTED");
    expect(await inventory()).toEqual(before);
    await assertNoNewSubject();
    expect(await coverage()).toMatchObject({ complete: false, missingUserIds: ["concurrent"] });
  });

  scenario("serializes approved claims on the policy lock without losing either inventory delta", async () => {
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    let releaseFirst = () => {};
    let enteredFirst = () => {};
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const entered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const claim = service(async (client, input) => {
      await createSubject(client, input);
      if (input.localUserId === REQUEST.localUserId) { enteredFirst(); await release; }
    });
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      await firstClient.query("begin; set local statement_timeout='10s'");
      await secondClient.query("begin; set local statement_timeout='10s'");
      const pid = (await secondClient.query("select pg_backend_pid() as pid")).rows[0]?.pid;
      first = claim.provision(firstClient, REQUEST);
      await Promise.race([entered, first.then(() => { throw new Error("first claim skipped its creation barrier"); })]);
      second = claim.provision(secondClient, { localUserId: "second-subject", openId: "ou-second", loginName: "second.alias" });
      // Retain the original rejection for await below, without an unhandled rejection during lock observation.
      void second.catch(() => {});
      // Observe a real PostgreSQL lock wait instead of inferring ordering from an arbitrary delay.
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await pool.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock";
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      releaseFirst();
      await first; await firstClient.query("commit");
      await second; await secondClient.query("commit");
      expect(await coverage()).toMatchObject({ complete: true });
      expect((await pool.query("select count(*)::int as count from enterprise_actor_reservations where local_user_id in ($1,$2)",
        [REQUEST.localUserId, "second-subject"])).rows[0]?.count).toBe(2);
    } finally {
      releaseFirst();
      try {
        await first?.catch(() => {});
        await firstClient.query("rollback");
        await second?.catch(() => {});
        await secondClient.query("rollback");
      } finally { firstClient.release(); secondClient.release(); }
    }
  });

  scenario("rechecks source age after creation and never renews the approved observation", async () => {
    const before = await inventory();
    const claim = service(async (client, input) => {
      await createSubject(client, input);
      now = before.observed_at.getTime() + 86_400_001;
    });
    await expect(transaction(client => claim.provision(client, REQUEST), true)).rejects.toThrow("ACTOR_INVENTORY_REJECTED");
    expect(await inventory()).toEqual(before);
    await assertNoNewSubject();
  });

  scenario("keeps a late writer blocked through the final snapshot and outer commit", async () => {
    const owner = await pool.connect();
    const writer = await pool.connect();
    let lateWrite: Promise<unknown> | undefined;
    let reads = 0;
    try {
      await owner.query("begin");
      await writer.query("begin; set local statement_timeout='10s'");
      const pid = (await writer.query("select pg_backend_pid() as pid")).rows[0]?.pid;
      const watched = afterQuery(owner, async sql => {
        if (!sql.startsWith("select u.id, u.name") || ++reads !== 3) return;
        lateWrite = writer.query('insert into "user" (id,name,email,email_verified) values (\'concurrent-late\',\'Late\',\'late@example.test\',false)');
        void lateWrite.catch(() => {});
        await waitForLock(pid);
      });
      await service().provision(watched, REQUEST);
      expect(reads).toBe(3);
      await waitForLock(pid);
      await owner.query("commit");
      await lateWrite;
      expect(await coverage()).toMatchObject({ complete: true });
      await writer.query("commit");
      expect(await coverage()).toMatchObject({ complete: false, missingUserIds: ["concurrent-late"] });
    } finally {
      try {
        await owner.query("rollback");
        await lateWrite?.catch(() => {});
        await writer.query("rollback");
      } finally { owner.release(); writer.release(); }
    }
  });

  scenario("rejects frozen snapshot isolation before any directory or creation work", async () => {
    const options = configuration();
    options.eligibility.directoryReader.read = async () => { throw new Error("directory must not run"); };
    for (const level of ["repeatable read", "serializable", "read uncommitted"]) {
      await expect(transaction(async client => {
        await client.query("set transaction isolation level " + level);
        return createActorClaimService(options).provision(client, REQUEST);
      }, true)).rejects.toThrow("ACTOR_CLAIM_TRANSACTION_REJECTED");
    }
    await assertNoNewSubject();
  });

  scenario("prepares the full 100-member batch before one barrier and seals it atomically", async () => {
    let barrier = false;
    let barrierCount = 0;
    const options = configuration(async (client, input) => {
      expect(barrier).toBe(false);
      await createSubject(client, input);
    });
    const originalRead = options.eligibility.directoryReader.read;
    options.eligibility.directoryReader.read = async openId => {
      expect(barrier).toBe(false);
      return originalRead(openId);
    };
    const requests = Array.from({ length: 100 }, (_, i) => ({ localUserId: "batch-" + i, openId: "ou-batch-" + i, loginName: "batch." + i }));
    const before = await inventory();
    const results = await transaction(client => createActorClaimService(options).provisionBatch(afterQuery(client, async sql => {
      if (sql.toLowerCase().startsWith("lock table")) { barrier = true; barrierCount++; }
    }), requests));
    expect(results).toHaveLength(100);
    expect(barrierCount).toBe(1);
    expect(await coverage()).toMatchObject({ complete: true });
    expect(await inventory()).toMatchObject({ operation_id: before.operation_id, source_digest: before.source_digest,
      observed_at: before.observed_at, upstream_actors: before.upstream_actors });
  });

  scenario("rejects empty, oversized and conflicting batches before any creation", async () => {
    const other = { localUserId: "second", openId: "ou-second", loginName: "second.alias" };
    for (const requests of [[], Array.from({ length: 101 }, (_, i) => ({ localUserId: "id" + i, openId: "ou" + i, loginName: "alias" + i })),
      [REQUEST, { ...other, localUserId: REQUEST.localUserId }], [REQUEST, { ...other, openId: REQUEST.openId }],
      [REQUEST, { ...other, loginName: REQUEST.loginName }], [REQUEST, { ...other, loginName: backend(REQUEST.localUserId) }]]) {
      await expect(transaction(client => service().provisionBatch(client, requests), true)).rejects.toThrow("INVALID_ACTOR_CLAIM");
    }
    await assertNoNewSubject();
    expect((await pool.query('select count(*)::int as n from "user"')).rows[0]?.n).toBe(1);
  });

  scenario("rolls back the entire batch when its second creation fails", async () => {
    const before = await inventory();
    const claim = service(async (client, input) => {
      await createSubject(client, input);
      if (input.localUserId === "second") throw new Error("second member failed");
    });
    await expect(transaction(client => claim.provisionBatch(client, [REQUEST,
      { localUserId: "second", openId: "ou-second", loginName: "second.alias" }]), true)).rejects.toThrow("second member failed");
    await assertNoNewSubject();
    expect((await pool.query('select count(*)::int as n from "user"')).rows[0]?.n).toBe(1);
    expect(await inventory()).toEqual(before);
  });

  scenario("freezes later batch members before the first directory await", async () => {
    const requests = [{ ...REQUEST }, { localUserId: "second", openId: "ou-second", loginName: "second.alias" }];
    const options = configuration();
    const originalRead = options.eligibility.directoryReader.read;
    options.eligibility.directoryReader.read = async openId => {
      requests[1] = { localUserId: "swapped", openId: "ou-swapped", loginName: "swapped.alias" };
      return originalRead(openId);
    };
    const results = await transaction(client => createActorClaimService(options).provisionBatch(client, requests));
    expect(results.map(result => result.localUserId)).toEqual([REQUEST.localUserId, "second"]);
    expect((await pool.query("select open_id from enterprise_identity where local_user_id='second'")).rows[0]?.open_id).toBe("ou-second");
    expect(await coverage()).toMatchObject({ complete: true });
  });

  scenario("rolls the entire batch back when a bounded post-barrier statement times out", async () => {
    const before = await inventory();
    await pool.query("create function fs71_slow_write() returns trigger language plpgsql as $$ begin perform pg_sleep(0.3); return new; end $$");
    await pool.query("create trigger fs71_slow_write before insert on enterprise_actor_reservations for each row execute function fs71_slow_write()");
    try {
      await expect(transaction(async client => {
        await client.query("set local statement_timeout='100ms'");
        return service().provision(client, REQUEST);
      }, true)).rejects.toMatchObject({ code: "57014" });
      await assertNoNewSubject();
      expect(await inventory()).toEqual(before);
    } finally {
      await pool.query("drop trigger fs71_slow_write on enterprise_actor_reservations");
      await pool.query("drop function fs71_slow_write()");
    }
  });

  scenario("rejects another factory claim in the same transaction before callbacks", async () => {
    let secondCreations = 0;
    await transaction(async client => {
      await service().provision(client, REQUEST);
      await expect(service(async () => { secondCreations++; }).provision(client,
        { localUserId: "second", openId: "ou-second", loginName: "second.alias" })).rejects.toThrow("ACTOR_CLAIM_TRANSACTION_REJECTED");
    });
    expect(secondCreations).toBe(0);
    expect(await coverage()).toMatchObject({ complete: true });
    // Transaction-local guard must reset when a pooled connection is reused.
    await transaction(client => service().provision(client, { localUserId: "second", openId: "ou-second", loginName: "second.alias" }));
    expect(await coverage()).toMatchObject({ complete: true });
  });

  scenario("bounds lock waits and restores timeout settings after savepoint rollback", async () => {
    const writer = await pool.connect();
    const before = await inventory();
    try {
      await writer.query('begin; lock table "user" in row exclusive mode');
      await transaction(async client => {
        await client.query("set local lock_timeout='100ms'; set local statement_timeout='12s'; set local idle_in_transaction_session_timeout='12s'");
        await expect(service().provision(client, REQUEST)).rejects.toMatchObject({ code: "55P03" });
        expect((await client.query("select name,setting from pg_settings where name in ('lock_timeout','statement_timeout','idle_in_transaction_session_timeout') order by name")).rows)
          .toEqual([{ name: "idle_in_transaction_session_timeout", setting: "12000" }, { name: "lock_timeout", setting: "100" },
            { name: "statement_timeout", setting: "12000" }]);
      });
      await assertNoNewSubject();
      expect(await inventory()).toEqual(before);
    } finally { await writer.query("rollback"); writer.release(); }
  });

  for (const failure of ["admission", "creation"]) {
    scenario("retains transaction guard after failed " + failure + " until the outer transaction ends", async () => {
      const before = await inventory();
      let reads = 0;
      const options = configuration(async (client, input) => {
        await createSubject(client, input);
        if (failure === "creation") throw new Error("synthetic creation failure");
      });
      const originalRead = options.eligibility.directoryReader.read;
      options.eligibility.directoryReader.read = async openId => { reads++; return originalRead(openId); };
      await transaction(async client => {
        admitted = failure !== "admission";
        await expect(createActorClaimService(options).provision(client, REQUEST))
          .rejects.toThrow(failure === "admission" ? "DIRECTORY_ADMISSION_REJECTED" : "synthetic creation failure");
        admitted = true;
        const next = configuration();
        next.eligibility.directoryReader.read = options.eligibility.directoryReader.read;
        await expect(createActorClaimService(next).provision(client, REQUEST)).rejects.toThrow("ACTOR_CLAIM_TRANSACTION_REJECTED");
      });
      expect(reads).toBe(1);
      await assertNoNewSubject();
      expect(await inventory()).toEqual(before);
      await transaction(client => service().provision(client, REQUEST));
      expect(await coverage()).toMatchObject({ complete: true });
    });
  }

  scenario("reads one protected inventory for 100 existing owners and fails closed on invalid batches", async () => {
    const ids = ["legacy", ...Array.from({ length: 99 }, (_, index) => "existing-" + index)];
    await pool.query('insert into "user"(id,name,email,email_verified) ' +
      "select id,id,id || '@example.test',false from unnest($1::text[]) as id", [ids.slice(1)]);
    await seal();
    const claim = service();
    let queries = 0;
    const found = await transaction(client => claim.existingOwners(afterQuery(client, async () => { queries++; }), ids));
    expect(queries).toBe(3);
    expect(found).toEqual(ids.map(id => ({ localUserId: id, backendUsername: id === "legacy" ? "legacyactor" : id, quarantined: false })));
    for (const invalid of [[], ["legacy", "legacy"], [...ids, "overflow"], ["missing"], ["\u0000"]]) {
      expect(await transaction(client => claim.existingOwners(client, invalid))).toBeUndefined();
    }
    await pool.query("insert into enterprise_quarantine(id,user_id,reason) values ('fs38-q','legacy','isolation')");
    expect(await transaction(client => claim.existingOwners(client, ["legacy"]))).toBeUndefined();
    await seal();
    expect(await transaction(client => claim.existingOwners(client, ["legacy"])))
      .toEqual([{ localUserId: "legacy", backendUsername: "legacyactor", quarantined: true }]);
    expect(await transaction(client => claim.existingOwner(client, "legacy")))
      .toEqual({ backendUsername: "legacyactor", quarantined: true });
    await pool.query("update enterprise_actor_reservations set actor_state='ambiguous',local_user_id=null,quarantined=false where backend_username='legacyactor'");
    await seal();
    expect(await transaction(client => claim.existingOwners(client, ["legacy"]))).toBeUndefined();
    now += 24 * 60 * 60 * 1000;
    expect(await transaction(client => claim.existingOwners(client, ["existing-0"]))).toBeUndefined();
  });

  scenario("fails a real lock-upgrade deadlock without retaining partial subjects", async () => {
    const writer = await pool.connect();
    let policyWait: Promise<unknown> | undefined;
    const before = await inventory();
    try {
      await writer.query("begin; set local deadlock_timeout='10s'; set local statement_timeout='15s'");
      const pid = (await writer.query("select pg_backend_pid() as pid")).rows[0]?.pid;
      const claim = service(async (client, input) => {
        await createSubject(client, input);
        await writer.query('lock table "user" in row exclusive mode');
        policyWait = writer.query("select id from enterprise_policy where scope=$1 for update", [SCOPE]);
        void policyWait.catch(() => {});
        await waitForLock(pid);
      });
      await expect(transaction(async client => {
        await client.query("set local deadlock_timeout='10ms'");
        return claim.provision(client, REQUEST);
      }, true)).rejects.toMatchObject({ code: "40P01" });
      await policyWait;
      await assertNoNewSubject();
      expect(await inventory()).toEqual(before);
    } finally {
      await policyWait?.catch(() => {});
      await writer.query("rollback"); writer.release();
    }
  });

  scenario("retains five-second bounds or stricter settings until the outer transaction ends", async () => {
    await transaction(async client => {
      await client.query("set local lock_timeout='0'; set local statement_timeout='2s'; set local idle_in_transaction_session_timeout='10s'");
      await service().provision(client, REQUEST);
      expect((await client.query("select name,setting from pg_settings where name in ('lock_timeout','statement_timeout','idle_in_transaction_session_timeout') order by name")).rows)
        .toEqual([{ name: "idle_in_transaction_session_timeout", setting: "5000" }, { name: "lock_timeout", setting: "5000" },
          { name: "statement_timeout", setting: "2000" }]);
    });
  });

  scenario("requires an explicit transaction and validates input without creating anything", async () => {
    const client = await pool.connect();
    try { await expect(service().provision(client, REQUEST)).rejects.toThrow(); }
    finally { client.release(); }
    for (const loginName of ["", "Bad Alias", "x", "alias\u0000"]) {
      await expect(transaction(client => service().provision(client, { ...REQUEST, loginName }))).rejects.toThrow("INVALID_ACTOR_CLAIM");
    }
    await assertNoNewSubject();
  });
});
