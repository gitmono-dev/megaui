// megaui-only (FS-33): real PostgreSQL login storage and forward migration recovery.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as publicSchema from "@megaui/database";
import { createIsolatedPostgres, resolveMigrationsFolder, type IsolatedPostgres } from "../../test-support/isolated-pg";

const TABLES = ["enterprise_pairings", "enterprise_challenges", "enterprise_login_budgets", "enterprise_dm_deliveries"] as const;
type LoginTable = (typeof TABLES)[number];
const at = (seconds = 0) => new Date(Date.UTC(2026, 10, 11, 12, 0, seconds));
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");

describe("enterprise login storage (FS-33)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let directory: string | undefined;
  let recovered = false;
  let originalRows: Record<string, unknown[]>;

  async function legacyRows(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    for (const table of ["user", "session", "enterprise_identity"]) {
      const columns = table === "session"
        ? "id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id, impersonated_by"
        : "*";
      result[table] = (await pool.query(`select ${columns} from "${table}" order by id`)).rows;
    }
    return result;
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    const source = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; idx: number; when: number }[];
    };
    const position = journal.entries.findIndex(entry =>
      readFileSync(join(source, `${entry.tag}.sql`), "utf8").includes('CREATE TABLE "enterprise_pairings"'));
    if (position >= 0) {
      directory = mkdtempSync(join(tmpdir(), "megaui-fs33-migrations-"));
      cpSync(source, directory, { recursive: true });
      writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }));
      await migrate(drizzle(pool), { migrationsFolder: directory });
    } else await isolated.migrate();
    await pool.query(`insert into "user" (id,name,email,email_verified,role) values ('old-user','Original User','old@example.test',false,'admin');
      insert into "session" (id,user_id,token,expires_at) values ('old-session','old-user','synthetic-existing-session','2030-01-01');
      insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id,identity_version)
        values ('old-identity','old-user','tenant-a','app-a','open-a',7)`);
    originalRows = await legacyRows();
    if (directory && position >= 0) {
      const entry = journal.entries[position];
      if (!entry) throw new Error("missing login migration");
      const previousJournal = (await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows;
      writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, position + 1) }));
      writeFileSync(join(directory, `${entry.tag}.sql`), readFileSync(join(source, `${entry.tag}.sql`), "utf8") +
        "\n--> statement-breakpoint\nSELECT 1 / 0;");
      await expect(migrate(drizzle(pool), { migrationsFolder: directory })).rejects.toThrow();
      for (const table of TABLES) expect((await pool.query("select to_regclass($1) as name", [`public.${table}`])).rows[0]?.name).toBeNull();
      expect((await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows).toEqual(previousJournal);
      expect(await legacyRows()).toEqual(originalRows);
      await isolated.migrate();
      expect(await legacyRows()).toEqual(originalRows);
      recovered = true;
    }
    await pool.query(`insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment)
      values ('fs33','fs33','megaui','test','test'),('fs33-other','fs33-other','megaui','test','test')`);
  }, 120_000);

  beforeEach(async () => {
    // Missing tables are the intended behavioral red before this schema exists.
    await pool.query("delete from enterprise_dm_deliveries; delete from enterprise_challenges; delete from enterprise_pairings; delete from enterprise_login_budgets");
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    try { if (directory) rmSync(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-33 fixture cleanup failed");
  }, 120_000);

  async function insert(table: LoginTable, row: Record<string, unknown>, client: Pool | PoolClient = pool): Promise<void> {
    const keys = Object.keys(row);
    await client.query(`insert into "${table}" (${keys.map(key => `"${key}"`).join(",")}) values (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(row));
  }
  function pairing(overrides: Record<string, unknown> = {}) {
    return { id: randomUUID(), scope: "fs33", deployment_role: "test", tenant_key: "tenant-a", app_id: "app-a",
      flow_hash: hash(), generation: 1, purpose: "login", token_hash: hash(), intended_identity_id: null,
      state: "pending", confirmed_identity_version: null, confirmed_message_id: null, confirmed_at: null,
      created_at: at(), expires_at: at(120), retain_until: at(120), ...overrides };
  }
  function confirmed(overrides: Record<string, unknown> = {}) {
    return pairing({ intended_identity_id: "old-identity", state: "confirmed", confirmed_identity_version: 7,
      confirmed_message_id: randomUUID(), confirmed_at: at(10), retain_until: at(400), ...overrides });
  }
  function challenge(overrides: Record<string, unknown> = {}) {
    return { id: randomUUID(), scope: "fs33", deployment_role: "test", local_user_id: "old-user", identity_id: "old-identity",
      identity_version: 7, flow_hash: hash(), generation: 1, purpose: "login", pairing_id: null,
      code_hmac: "a".repeat(64), hmac_key_id: "hmac-v1", state: "active", failed_attempts: 0,
      created_at: at(), expires_at: at(300), consumed_at: null, recover_until: null,
      secret_expires_at: at(300), secret_cleared_at: null, ...overrides };
  }
  function delivery(challengeId: string, overrides: Record<string, unknown> = {}) {
    return { id: randomUUID(), challenge_id: challengeId, delivery_key_id: "delivery-v1", encrypted_payload: "A".repeat(48),
      created_at: at(), expires_at: at(300), first_attempt_at: null, sent_at: null, ...overrides };
  }
  function budget(overrides: Record<string, unknown> = {}) {
    return { scope: "fs33", deployment_role: "test", budget_kind: "anonymous-ip", subject_hash: hash(),
      window_started_at: at(), used: 0, expires_at: at(600), next_allowed_at: null, ...overrides };
  }

  it("stores an unknown alias pairing without allowing it to become confirmed", async () => {
    const row = pairing();
    await insert("enterprise_pairings", row);
    expect((await pool.query("select intended_identity_id,state from enterprise_pairings")).rows).toEqual([{ intended_identity_id: null, state: "pending" }]);
    await expect(insert("enterprise_pairings", confirmed({ intended_identity_id: null }))).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back all new DDL and the journal then retries forward preserving existing users and sessions", async () => {
    expect(recovered).toBe(true);
    expect(await legacyRows()).toEqual(originalRows);
    const ledger = (await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows;
    await isolated.migrate();
    expect((await pool.query("select * from drizzle.__drizzle_migrations order by id")).rows).toEqual(ledger);
  });

  it("exports every login table through the public database entry point", () => {
    expect([publicSchema.enterprisePairings, publicSchema.enterpriseChallenges, publicSchema.enterpriseLoginBudgets, publicSchema.enterpriseDmDeliveries].map(getTableName)).toEqual([...TABLES]);
  });

  it("makes token digests globally unique and scopes pending flows and generations", async () => {
    const row = pairing();
    await insert("enterprise_pairings", row);
    await expect(insert("enterprise_pairings", pairing({ token_hash: row.token_hash, scope: "fs33-other" }))).rejects.toMatchObject({ code: "23505" });
    await expect(insert("enterprise_pairings", pairing({ flow_hash: row.flow_hash, generation: 2 }))).rejects.toMatchObject({ code: "23505" });
    await pool.query("update enterprise_pairings set state='expired'");
    await expect(insert("enterprise_pairings", pairing({ flow_hash: row.flow_hash }))).rejects.toMatchObject({ code: "23505" });
    await insert("enterprise_pairings", pairing({ flow_hash: row.flow_hash, generation: 2 }));
    await insert("enterprise_pairings", pairing({ flow_hash: row.flow_hash, scope: "fs33-other" }));
  });

  it("rejects unknown scopes, absent deployment, malformed digests, generations and plaintext tokens", async () => {
    await expect(insert("enterprise_pairings", pairing({ scope: "missing" }))).rejects.toMatchObject({ code: "23503" });
    for (const override of [{ deployment_role: null }, { deployment_role: "unknown" }, { flow_hash: "FLOW" }, { token_hash: "7K3M9Q2H" },
      { generation: 0 }, { purpose: "reset" }, { tenant_key: " " }, { app_id: "a".repeat(257) }, { state: "unknown" }]) {
      await expect(insert("enterprise_pairings", pairing(override))).rejects.toThrow();
    }
  });

  it("requires complete finite confirmation and preserves recovery retention beyond pairing expiry", async () => {
    await insert("enterprise_pairings", confirmed());
    for (const override of [{ confirmed_at: null }, { confirmed_at: at(120) }, { confirmed_at: at(-1) }, { confirmed_message_id: " " },
      { confirmed_identity_version: 0 }, { retain_until: at(120) }, { retain_until: "infinity" }, { expires_at: at(121) }, { created_at: "-infinity" }]) {
      await expect(insert("enterprise_pairings", confirmed(override))).rejects.toThrow();
    }
    await expect(insert("enterprise_pairings", pairing({ confirmed_message_id: "unexpected" }))).rejects.toMatchObject({ code: "23514" });
  });

  it("deduplicates the real sender message across event ids and flows", async () => {
    await insert("enterprise_pairings", confirmed({ confirmed_message_id: "message-a" }));
    await expect(insert("enterprise_pairings", confirmed({ confirmed_message_id: "message-a" }))).rejects.toMatchObject({ code: "23505" });
    await insert("enterprise_pairings", confirmed({ confirmed_message_id: "message-a", scope: "fs33-other" }));
  });

  it("binds challenge flow, identity version, purpose and one active generation", async () => {
    const row = challenge();
    await insert("enterprise_challenges", row);
    await expect(insert("enterprise_challenges", challenge({ flow_hash: row.flow_hash, generation: 2 }))).rejects.toMatchObject({ code: "23505" });
    await pool.query("update enterprise_challenges set state='superseded'");
    await expect(insert("enterprise_challenges", challenge({ flow_hash: row.flow_hash }))).rejects.toMatchObject({ code: "23505" });
    await insert("enterprise_challenges", challenge({ flow_hash: row.flow_hash, generation: 2 }));
    for (const override of [{ flow_hash: null }, { flow_hash: "bad" }, { identity_version: null }, { identity_version: 0 },
      { generation: 0 }, { purpose: "reset" }, { state: "unknown" }, { failed_attempts: -1 }, { failed_attempts: 6 }]) {
      await expect(insert("enterprise_challenges", challenge(override))).rejects.toThrow();
    }
    await expect(insert("enterprise_challenges", challenge({ identity_id: "missing" }))).rejects.toMatchObject({ code: "23503" });
    await expect(insert("enterprise_challenges", challenge({ local_user_id: "missing" }))).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces challenge and recovery deadlines while allowing HMAC removal without resetting consumption", async () => {
    const row = challenge({ state: "consumed", consumed_at: at(299), recover_until: at(389), secret_expires_at: at(389), failed_attempts: 5 });
    await insert("enterprise_challenges", row);
    await expect(pool.query("update enterprise_challenges set code_hmac=null,hmac_key_id=null,secret_cleared_at=$1", [at(388)])).rejects.toMatchObject({ code: "23514" });
    await pool.query("update enterprise_challenges set code_hmac=null,hmac_key_id=null,secret_cleared_at=$1", [at(389)]);
    expect((await pool.query("select state,identity_version,failed_attempts,code_hmac,hmac_key_id,recover_until from enterprise_challenges")).rows)
      .toEqual([{ state: "consumed", identity_version: 7, failed_attempts: 5, code_hmac: null, hmac_key_id: null, recover_until: at(389) }]);
    await expect(pool.query("update enterprise_challenges set state='active'")).rejects.toMatchObject({ code: "23514" });
    for (const override of [{ expires_at: at(301) }, { secret_expires_at: at(301) }, { consumed_at: at(5) },
      { code_hmac: "7K3M9Q2H" }, { hmac_key_id: " " }, { code_hmac: null }, { created_at: "-infinity" }, { expires_at: "infinity" },
      { state: "consumed", consumed_at: at(300), recover_until: at(390), secret_expires_at: at(390) }]) {
      await expect(insert("enterprise_challenges", challenge(override))).rejects.toThrow();
    }
  });

  it("allows pairing cleanup without erasing challenge recovery metadata", async () => {
    const pair = confirmed();
    await insert("enterprise_pairings", pair);
    const row = challenge({ pairing_id: pair.id });
    await insert("enterprise_challenges", row);
    await expect(insert("enterprise_challenges", challenge({ pairing_id: pair.id }))).rejects.toMatchObject({ code: "23505" });
    await pool.query("delete from enterprise_pairings");
    expect((await pool.query("select id,pairing_id,identity_version from enterprise_challenges")).rows)
      .toEqual([{ id: row.id, pairing_id: null, identity_version: 7 }]);
  });

  it("uses a shared budget key across independent database clients", async () => {
    const a = await pool.connect(), b = await pool.connect();
    const row = budget({ used: 1 });
    try {
      const results = await Promise.allSettled([insert("enterprise_login_budgets", row, a), insert("enterprise_login_budgets", row, b)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ status: "rejected", reason: { code: "23505" } });
    } finally { a.release(); b.release(); }
    expect((await pool.query("select used from enterprise_login_budgets")).rows).toEqual([{ used: 1 }]);
    await insert("enterprise_login_budgets", { ...row, scope: "fs33-other" });
    await insert("enterprise_login_budgets", { ...row, budget_kind: "verify-failure" });
    const columns = (await pool.query("select column_name from information_schema.columns where table_name='enterprise_login_budgets'")).rows.map(row => row.column_name);
    expect(columns).not.toContain("generation");
    expect(columns).not.toContain("process_id");
    expect(columns).not.toContain("ip_address");
  });

  it("rejects malformed or unbounded budget records", async () => {
    for (const override of [{ used: -1 }, { budget_kind: "unknown" }, { subject_hash: "127.0.0.1" }, { deployment_role: "unknown" },
      { expires_at: at() }, { expires_at: "infinity" }, { window_started_at: "-infinity" }, { next_allowed_at: "infinity" }]) {
      await expect(insert("enterprise_login_budgets", budget(override))).rejects.toThrow();
    }
    await expect(insert("enterprise_login_budgets", budget({ scope: "missing" }))).rejects.toMatchObject({ code: "23503" });
  });

  it("permits only one encrypted delivery per challenge and its original expiry", async () => {
    const row = challenge();
    await insert("enterprise_challenges", row);
    await expect(insert("enterprise_dm_deliveries", delivery(row.id, { expires_at: at(301) }))).rejects.toMatchObject({ code: "23503" });
    await insert("enterprise_dm_deliveries", delivery(row.id));
    await expect(insert("enterprise_dm_deliveries", delivery(row.id))).rejects.toMatchObject({ code: "23505" });
    await pool.query("delete from enterprise_challenges");
    expect((await pool.query("select * from enterprise_dm_deliveries")).rows).toEqual([]);
  });

  it("rejects plaintext-sized payloads and invalid secret metadata or times", async () => {
    const row = challenge();
    await insert("enterprise_challenges", row);
    for (const override of [{ encrypted_payload: "7K3M9Q2H" }, { encrypted_payload: "A".repeat(8193) }, { encrypted_payload: "A".repeat(47) + "!" },
      { delivery_key_id: " " }, { first_attempt_at: at(-1) }, { sent_at: "infinity" }, { first_attempt_at: "-infinity" },
      { created_at: at(300) }, { expires_at: "infinity" }]) {
      await expect(insert("enterprise_dm_deliveries", delivery(row.id, override))).rejects.toThrow();
    }
    const columns = (await pool.query("select column_name from information_schema.columns where table_name=any($1::text[])", [[...TABLES]])).rows.map(row => row.column_name);
    for (const forbidden of ["code", "otp", "token", "pairing_token", "flow", "message_text", "ip_address", "lease_until", "claim_owner"]) expect(columns).not.toContain(forbidden);
  });

  it("provides indexed bounded cleanup paths for pending, secret, quota and encrypted records", async () => {
    const indexes = (await pool.query<{ tablename: string; indexdef: string }>(
      "select tablename,indexdef from pg_indexes where schemaname='public' and tablename=any($1::text[])", [[...TABLES]])).rows;
    for (const [table, column] of [["enterprise_pairings", "retain_until"], ["enterprise_challenges", "secret_expires_at"],
      ["enterprise_challenges", "expires_at"], ["enterprise_login_budgets", "expires_at"], ["enterprise_dm_deliveries", "expires_at"]]) {
      expect(indexes.some(index => index.tablename === table && index.indexdef.includes(`(${column})`))).toBe(true);
    }
    expect(indexes.some(index => index.tablename === "enterprise_challenges" && index.indexdef.includes("secret_expires_at") && index.indexdef.includes("code_hmac IS NOT NULL"))).toBe(true);
    expect(indexes.some(index => index.tablename === "enterprise_pairings" && index.indexdef.includes("scope, intended_identity_id, state"))).toBe(true);
  });
});
