// FS-53: maintenance-window compatibility-key conversion.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type EnterpriseScopeExpectation } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import type { GuardedWriteContext } from "../../cli/admin-approval";
import { runActorReservationMutation } from "./actor-reservations";
import { compatibilityEmail } from "./identity-key";
import { migrationUserVersion } from "./manifest";
import { createMigrationLedger } from "./migration-ledger";
import { previewMigration } from "./migration-preview";
import { runConversionMutation } from "./conversion";

const SCOPE = "fs53-instance", TENANT = "fs53-tenant", APP = "fs53-app";
const EXPECTATION: EnterpriseScopeExpectation = {
  processRole: "test", ownerFingerprint: "megaui", instanceId: SCOPE, environment: "test",
};
const AUTHORITY = { tenantKey: TENANT, appId: APP };
const previousEnv = { ...process.env };

describe("maintenance conversion (FS-53)", () => {
  let isolated: IsolatedPostgres, pool: Pool, manifest: Buffer, digest: string;

  async function reserveActors(): Promise<void> {
    const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1,
      observedAt: new Date().toISOString().replace(/\.(\d{3})\dZ$/, ".$1Z"), actors: [] }));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await runActorReservationMutation({ verb: "reserve-actors", operationId: randomUUID(),
        args: { target: SCOPE, digest: createHash("sha256").update(snapshot).digest("hex") },
        files: { names: () => ["upstream"], bytes: () => snapshot } }, client);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  function context(verb: "apply" | "convert", batch: number): GuardedWriteContext {
    const operationId = randomUUID();
    return { verb, operationId, args: { target: SCOPE, "operation-id": operationId,
      "expect-policy-epoch": 3, digest, "batch-number": batch },
      files: { names: () => ["manifest"], bytes: name => name === "manifest" ? manifest : undefined } };
  }

  async function executeLedgerBatch(batch: number): Promise<void> {
    const client = await pool.connect();
    const current = context("apply", batch);
    const ledger = createMigrationLedger({ expectation: EXPECTATION, authority: AUTHORITY });
    try {
      await client.query("begin");
      await ledger.executeBatch(current, client, async (transaction, members) => {
        for (const member of members) {
          await transaction.query(
            "insert into enterprise_identity(id,local_user_id,tenant_key,app_id,open_id,status,identity_version) " +
              "values ($1,$2,$3,$4,$5,'active',1)",
            [randomUUID(), member.local_user_id, TENANT, APP, member.open_id],
          );
          await transaction.query(
            "insert into enterprise_profile(user_id,tenant_key,login_name,backend_username,display_name) " +
              "values ($1,$2,$3,$4,'fixture display')",
            [member.local_user_id, TENANT, member.login_name, member.backend_username],
          );
        }
      });
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async function convertBatch(batch: number): Promise<unknown> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await runConversionMutation(context("convert", batch), client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      return error;
    } finally { client.release(); }
  }

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: isolated.databaseUrl,
      ENTERPRISE_DB_INSTANCE_ID: SCOPE, ENTERPRISE_PROCESS_ROLE: "test", ENTERPRISE_DEPLOYMENT_ROLE: "test",
      ENTERPRISE_OWNER_FINGERPRINT: "megaui", FEISHU_TENANT_KEY: TENANT, FEISHU_APP_ID: APP });
    await pool.query(
      'delete from enterprise_batch_checkpoints; delete from enterprise_admin_operations; ' +
        'delete from enterprise_actor_inventory; delete from enterprise_actor_reservations; ' +
        'delete from enterprise_quarantine; delete from enterprise_identity; delete from enterprise_profile; ' +
        'delete from mega_doc_collaborators; delete from mega_doc_versions; delete from mega_doc_comments; ' +
        'delete from mega_doc_stars; delete from mega_docs; ' +
        'delete from "user"; delete from enterprise_policy',
    );
    await pool.query(
      "insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,auth_epoch,activation_state) " +
        "values ('policy',$1,'megaui','test','test',3,'maintenance')", [SCOPE],
    );
    await pool.query(
      'insert into "user"(id,name,email,email_verified,role,updated_at) ' +
        "select 'legacy-'||lpad(i::text,3,'0'),' Actor '||i||' ','old-'||i||'@example.test',true,case when i=1 then 'admin' else 'user' end,'2026-11-11T01:02:03.123456Z' " +
        "from generate_series(1,101) i",
    );
    await pool.query(
      "insert into mega_docs(id,title,author_id) values ('fs53-doc','FS-53 fixture','legacy-001')",
    );
    await pool.query(
      "insert into mega_doc_collaborators(id,doc_id,user_id,role) values ('fs53-acl','fs53-doc','legacy-001','owner')",
    );
    await reserveActors();
    const rows = (await pool.query(
      'select id,name,email,email_verified as "emailVerified",banned,' +
        'to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z\') as "updatedAt" ' +
        'from "user" order by id',
    )).rows;
    manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, members: rows.map(row => ({ local_user_id: row.id,
      tenant_key: TENANT, app_id: APP, open_id: "open-" + row.id, login_name: "alias-" + row.id,
      expected_user_version: migrationUserVersion(row), expected_identity_version: 0 })) }));
    const report = await previewMigration({ bytes: manifest, databaseUrl: isolated.databaseUrl,
      expectation: EXPECTATION, authority: AUTHORITY, deadline: performance.now() + 30_000 });
    expect(report.status).toBe("ready");
    digest = report.manifestDigest!;
  });

  it("converts approved subjects in batches of at most 100 and preserves identity/profile FKs", async () => {
    await executeLedgerBatch(0);
    expect(await convertBatch(0)).toMatchObject({ message: "MIGRATION_REJECTED", key: "MIGRATION_REJECTED" });
    await executeLedgerBatch(1);
    await pool.query("update enterprise_policy set activation_state='enterprise' where scope=$1", [SCOPE]);
    expect(await convertBatch(0)).toMatchObject({ message: "MIGRATION_REJECTED", key: "MIGRATION_REJECTED" });
    await pool.query("update enterprise_policy set activation_state='maintenance' where scope=$1", [SCOPE]);
    expect(await convertBatch(0)).toEqual({ processed: 100 });
    const first = await pool.query(
      'select u.id,u.email,u.email_verified,u.role,p.user_id as profile_user_id,p.backend_username,p.notification_email,i.local_user_id,d.author_id,c.user_id as acl_user_id,c.role as acl_role ' +
        'from "user" u join enterprise_profile p on p.user_id=u.id join enterprise_identity i on i.local_user_id=u.id ' +
        'join mega_docs d on d.author_id=u.id join mega_doc_collaborators c on c.user_id=u.id ' +
        "where u.id='legacy-001'",
    );
    expect(first.rows).toEqual([{ id: "legacy-001", email: compatibilityEmail("legacy-001"), email_verified: false, role: "admin",
      profile_user_id: "legacy-001", backend_username: " Actor 1 ", notification_email: "old-1@example.test", local_user_id: "legacy-001",
      author_id: "legacy-001", acl_user_id: "legacy-001", acl_role: "owner" }]);
    expect((await pool.query("select email from \"user\" where id='legacy-101'")).rows[0].email).toBe("old-101@example.test");
    expect(await convertBatch(0)).toEqual({ processed: 100 });
  });

  it("rolls back a failed checkpoint and retries the same second batch", async () => {
    await executeLedgerBatch(0); await executeLedgerBatch(1); await convertBatch(0);
    await pool.query(
      "create function fs53_fail_conversion() returns trigger language plpgsql as $$ begin " +
        "if new.id='legacy-101' then raise exception 'fs53 fixture failure'; end if; return new; end $$",
    );
    await pool.query('create trigger fs53_fail_conversion before update of email on "user" ' +
      "for each row execute function fs53_fail_conversion()");
    const failed = await convertBatch(1);
    expect(failed).toMatchObject({ message: "fs53 fixture failure" });
    expect((await pool.query("select count(*)::int as n from enterprise_batch_checkpoints where manifest_digest=$1", [digest])).rows[0].n).toBe(3);
    expect((await pool.query("select email from \"user\" where id='legacy-101'")).rows[0].email).toBe("old-101@example.test");
    await pool.query('drop trigger fs53_fail_conversion on "user"; drop function fs53_fail_conversion()');
    expect(await convertBatch(1)).toEqual({ processed: 1 });
    expect((await pool.query("select email,email_verified from \"user\" where id='legacy-101'")).rows[0])
      .toEqual({ email: compatibilityEmail("legacy-101"), email_verified: false });
    expect((await pool.query("select state from enterprise_admin_operations where verb='internal:migration-run:v1'")).rows[0].state).toBe("completed");
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await pool?.end();
    await isolated?.destroy();
  }, 120_000);
});
