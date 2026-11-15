// megaui-only (FS-75): exercise the production sender budget on owned PostgreSQL.
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import {
  createEnterpriseSenderBudget,
  type EnterpriseSenderBudgetOptions,
} from "./sender-budget";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const expectation = { processRole: "test", ownerFingerprint: "megaui", instanceId: "fs75", environment: "test" } as const;
const flow = (value: string) => digest(`flow:${value}`);
const request = (senderOpenId: string, identityId = "fs75-identity", flowHash = flow(senderOpenId)) => ({
  senderOpenId, identityId, flowHash, validToken: true as const,
});

describe("enterprise trusted sender budget (FS-75)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  const options = (overrides: Partial<EnterpriseSenderBudgetOptions> = {}): EnterpriseSenderBudgetOptions => ({
    pool,
    expectation,
    tenantKey: "tenant",
    appId: "app",
    ...overrides,
  });
  const budget = (overrides: Partial<EnterpriseSenderBudgetOptions> = {}) => createEnterpriseSenderBudget(options(overrides));
  const run = (senderOpenId: string, identityId = "fs75-identity", flowHash = flow(senderOpenId)) =>
    budget().run(request(senderOpenId, identityId, flowHash), async context => context.flowHash);

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, max: 4 });
    pool.on("error", () => {});
    await pool.query(`insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ('fs75','fs75','megaui','test','test','enterprise',1);
      insert into "user" (id,name,email,email_verified) values ('fs75-user','FS75 User','fs75@example.test',false);
      insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id)
        values ('fs75-identity','fs75-user','tenant','app','fs75-open')`);
  }, 120_000);

  beforeEach(async () => {
    await pool.query("delete from enterprise_challenges; delete from enterprise_pairings; delete from enterprise_login_budgets;");
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-75 sender budget fixture cleanup failed");
  }, 120_000);

  async function insertConfirmedPairing(id: string, flowHash: string): Promise<void> {
    await pool.query(`insert into enterprise_pairings
      (id,scope,deployment_role,tenant_key,app_id,flow_hash,generation,purpose,token_hash,intended_identity_id,state,
       confirmed_identity_version,confirmed_message_id,confirmed_at,created_at,expires_at,retain_until)
      values ($1,'fs75','test','tenant','app',$2,1,'login',$3,'fs75-identity','confirmed',1,$4,
        now()-interval '9 seconds',now()-interval '10 seconds',now()+interval '110 seconds',now()+interval '381 seconds')`,
    [id, flowHash, digest(`token:${id}`), `message-${id}`]);
  }

  it("enforces the 60-second sender interval and does not evict an existing flow", async () => {
    expect(await run("ou-sender", "fs75-identity", flow("one"))).toEqual({ kind: "accepted", value: flow("one") });
    expect(await run("ou-sender", "fs75-identity", flow("two"))).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets where budget_kind='sender-send'")).rows[0]?.count).toBe(2);
  });

  it("enforces five sends per identity in the rolling ten-minute window", async () => {
    const identityHash = digest(JSON.stringify(["megaui:sender-budget:subject:v1", "identity", "fs75-identity"]));
    await pool.query(`insert into enterprise_login_budgets
      (scope,deployment_role,budget_kind,subject_hash,window_started_at,used,expires_at)
      values ('fs75','test','sender-send',$1,now()-interval '1 minute',5,now()+interval '9 minutes')`, [identityHash]);
    expect(await run("ou-identity-limit", "fs75-identity", flow("identity-limit"))).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets where budget_kind='sender-send'")).rows[0]?.count).toBe(1);
  });

  it("enforces the three confirmed-flow cap while allowing a resend on an existing flow", async () => {
    const flows = [flow("confirmed-1"), flow("confirmed-2"), flow("confirmed-3")];
    for (const [index, flowHash] of flows.entries()) await insertConfirmedPairing(`00000000-0000-0000-0000-00000000000${index + 1}`, flowHash);
    expect(await run("ou-fourth-flow", "fs75-identity", flow("confirmed-4"))).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect((await pool.query("select count(*)::int as count from enterprise_pairings")).rows[0]?.count).toBe(3);
    expect(await run("ou-resend", "fs75-identity", flows[0])).toEqual({ kind: "accepted", value: flows[0] });
  });

  it("charges invalid tokens only to the sender public bucket", async () => {
    const result = await budget().run({ senderOpenId: "ou-invalid", identityId: "not-used", flowHash: "not-used", validToken: false }, async () => "must-not-run");
    expect(result).toEqual({ kind: "invalid-token" });
    expect((await pool.query("select budget_kind,used from enterprise_login_budgets")).rows).toEqual([{ budget_kind: "sender-invalid", used: 1 }]);
    for (let count = 1; count < 10; count += 1) {
      expect(await budget().run({ senderOpenId: "ou-invalid", validToken: false }, async () => "must-not-run")).toEqual({ kind: "invalid-token" });
    }
    expect(await budget().run({ senderOpenId: "ou-invalid", validToken: false }, async () => "must-not-run")).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets where budget_kind='sender-send'")).rows[0]?.count).toBe(0);
  });

  it("serializes concurrent instances so only one sender send is accepted", async () => {
    const second = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, max: 2 });
    second.on("error", () => {});
    try {
      const firstBudget = createEnterpriseSenderBudget(options());
      const secondBudget = createEnterpriseSenderBudget({ ...options(), pool: second });
      const results = await Promise.all([
        firstBudget.run(request("ou-concurrent", "fs75-identity", flow("concurrent-a")), async context => {
          await new Promise(resolve => setTimeout(resolve, 20));
          return context.flowHash;
        }),
        secondBudget.run(request("ou-concurrent", "fs75-identity", flow("concurrent-b")), async context => context.flowHash),
      ]);
      expect(results.filter(result => result.kind === "accepted")).toHaveLength(1);
      expect(results.filter(result => result.kind === "rate-limited")).toHaveLength(1);
    } finally { await second.end(); }
  });

  it("rolls back reserved budgets when challenge creation fails, preserving other-flow capacity", async () => {
    expect(await budget().run(request("ou-failure", "fs75-identity", flow("failure-a")), async () => { throw new Error("synthetic challenge failure"); })).toEqual({ kind: "unavailable" });
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets")).rows[0]?.count).toBe(0);
    expect(await run("ou-failure", "fs75-identity", flow("failure-b"))).toEqual({ kind: "accepted", value: flow("failure-b") });
  });
});
