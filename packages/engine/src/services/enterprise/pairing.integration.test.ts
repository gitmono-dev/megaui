// megaui-only (FS-11): exercise the production pairing service on an owned migrated database.
import { createHash, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { createEnterprisePairingService, type EnterprisePairingServiceOptions } from "./pairing";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const flow = () => digest(randomUUID());
const expectation = { processRole: "test", ownerFingerprint: "megaui", instanceId: "fs11", environment: "test" } as const;
const input = (loginName = "alice", flowHash = flow()) => ({ loginName, flowHash, transport: { peerAddress: "192.0.2.1" } });

describe("production pairing service (FS-11)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  const options = (overrides: Partial<EnterprisePairingServiceOptions> = {}): EnterprisePairingServiceOptions =>
    ({ pool, expectation, tenantKey: "tenant", appId: "app", proxyCidrs: [], ipHmacMaster: new Uint8Array(32).fill(42), alert: () => undefined, ...overrides });
  const service = (overrides: Partial<EnterprisePairingServiceOptions> = {}) => createEnterprisePairingService(options(overrides));
  const totals = async () => (await pool.query(`select (select count(*)::int from enterprise_pairings) as pairings,
    (select count(*)::int from enterprise_jobs) as jobs,
    (select count(*)::int from enterprise_login_budgets where budget_kind <> 'anonymous-ip') as identity_budgets`)).rows[0];

  beforeAll(async () => {
    isolated = await createIsolatedPostgres(); await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000 });
    pool.on("error", () => {});
    expect(new URL(isolated.databaseUrl).hostname).toBe("127.0.0.1");
    await pool.query(`insert into enterprise_policy (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ('fs11','fs11','megaui','test','test','enterprise',1);
      insert into "user" (id,name,email,email_verified) values ('fs11-user','Synthetic Alice','alice@example.test',false);
      insert into enterprise_profile (user_id,tenant_key,login_name,backend_username,notification_email)
      values ('fs11-user','tenant','alice','backend-alice','notification@example.test');
      insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id)
      values ('fs11-identity','fs11-user','tenant','app','open-alice')`);
  }, 120_000);
  beforeEach(async () => {
    await pool.query(`delete from enterprise_challenges; delete from enterprise_pairings; delete from enterprise_login_budgets;
      update enterprise_policy set activation_state='enterprise',auth_epoch=1 where scope='fs11'`);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await pool?.end(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "FS-11 pairing fixture cleanup failed");
  }, 120_000);

  it("returns the same opaque 202 shape for known and unknown aliases, with exact text token digests", async () => {
    const pairing = service();
    for (const [alias, intended] of [["alice", "fs11-identity"], ["unknown", null]] as const) {
      const request = input(alias); const result = await pairing.request(request);
      expect(result).toMatchObject({ kind: "accepted", status: 202, body: { expiresIn: 120, resendAfter: 60 } });
      if (result.kind !== "accepted") throw Error("expected accepted");
      expect(Object.keys(result.body).sort()).toEqual(["expiresIn", "pairingId", "pairingToken", "resendAfter"]);
      expect(result.body.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const raw = Buffer.from(result.body.pairingToken, "base64url");
      expect(raw).toHaveLength(32); expect(raw.toString("base64url")).toBe(result.body.pairingToken);
      const row = (await pool.query(`select * from enterprise_pairings where id=$1`, [result.body.pairingId])).rows[0];
      expect(row).toMatchObject({ scope: "fs11", deployment_role: "test", tenant_key: "tenant", app_id: "app",
        flow_hash: request.flowHash, token_hash: digest(result.body.pairingToken), generation: 1,
        intended_identity_id: intended, state: "pending", purpose: "login" });
      expect(row.token_hash).not.toBe(createHash("sha256").update(raw).digest("hex"));
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(120_000);
      expect(row.retain_until).toEqual(row.expires_at);
      expect(JSON.stringify(row)).not.toContain(result.body.pairingToken);
    }
    expect(await totals()).toEqual({ pairings: 2, jobs: 0, identity_budgets: 0 });
  });

  it("pins tenant/app authority and uses exact aliases rather than email or display names", async () => {
    for (const fixed of [{ tenantKey: "other" }, { appId: "other" }]) {
      const result = await service(fixed).request(input());
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") throw Error("expected accepted");
      expect((await pool.query("select intended_identity_id from enterprise_pairings where id=$1", [result.body.pairingId])).rows[0]?.intended_identity_id).toBeNull();
    }
    for (const alias of ["Alice", "Synthetic Alice", "notification@example.test"]) {
      const result = await service().request(input(alias));
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") throw Error("expected accepted");
      expect((await pool.query("select intended_identity_id from enterprise_pairings where id=$1", [result.body.pairingId])).rows[0]?.intended_identity_id).toBeNull();
    }
  });

  it("rejects malformed trusted input and attempted authority overrides before any SQL", async () => {
    const pairing = service();
    const query = vi.spyOn(Client.prototype, "query");
    try {
      for (const value of [null, [], { ...input(), loginName: 1 }, { ...input(), loginName: "" },
        { ...input(), loginName: "a".repeat(65) }, { ...input(), flowHash: "bad" },
        { ...input(), flowHash: "a".repeat(64) + "\n" }, { ...input(), scope: "other" },
        { ...input(), tenantKey: "other" }, { ...input(), appId: "other" }, { ...input(), deploymentRole: "production" }]) {
        expect(await pairing.request(value as Parameters<typeof pairing.request>[0])).toEqual({ kind: "unavailable" });
      }
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
    expect(await totals()).toEqual({ pairings: 0, jobs: 0, identity_budgets: 0 });
  });

  it("keeps one pending per flow and exposes no old token on a repeated request", async () => {
    const pairing = service(); const request = input();
    expect((await pairing.request(request)).kind).toBe("accepted");
    expect(await pairing.request(request)).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect(await totals()).toEqual({ pairings: 1, jobs: 0, identity_budgets: 0 });
  });

  it("composes the real IP budget: the thirty-first flow has no pairing or token", async () => {
    const pairing = service(); const tokens = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      const result = await pairing.request(input());
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") throw Error("expected accepted");
      tokens.add(result.body.pairingToken);
    }
    expect(tokens.size).toBe(30);
    expect(await pairing.request(input())).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect(await totals()).toEqual({ pairings: 30, jobs: 0, identity_budgets: 0 });
  });

  it("returns unavailable when COMMIT succeeds but its acknowledgement is lost", async () => {
    const candidate = new Pool({ connectionString: isolated.databaseUrl, connectionTimeoutMillis: 1000, max: 1 });
    candidate.on("error", () => {});
    const client = await candidate.connect(); const original = client.query.bind(client);
    const query = vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      const result = await original(sql, values);
      if (sql === "commit") throw Error("synthetic lost commit acknowledgement");
      return result;
    }) as typeof client.query);
    client.release();
    try {
      const request = input(); const pairing = service({ pool: candidate });
      expect(await pairing.request(request)).toEqual({ kind: "unavailable" });
      // The row really committed, yet neither the token nor a success DTO escaped.
      expect(await totals()).toEqual({ pairings: 1, jobs: 0, identity_budgets: 0 });
      query.mockRestore();
      expect(await pairing.request(request)).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    } finally { query.mockRestore(); await candidate.end(); }
  });

  it("takes the next generation from both tables without superseding an active challenge", async () => {
    const request = input(); const challengeId = randomUUID();
    await pool.query(`insert into enterprise_challenges
      (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,code_hmac,hmac_key_id,created_at,expires_at,secret_expires_at)
      values ($1,'fs11','test','fs11-user','fs11-identity',1,$2,8,$3,'synthetic-key',now(),now()+interval '300 seconds',now()+interval '300 seconds')`,
    [challengeId, request.flowHash, digest("synthetic-code")]);
    const before = (await pool.query("select * from enterprise_challenges where id=$1", [challengeId])).rows[0];
    const result = await service().request(request);
    expect(result.kind).toBe("accepted");
    expect((await pool.query("select generation from enterprise_pairings")).rows[0]?.generation).toBe(9);
    expect((await pool.query("select * from enterprise_challenges where id=$1", [challengeId])).rows[0]).toEqual(before);
    await pool.query(`update enterprise_pairings set state='expired', generation=12`);
    expect((await service().request(request)).kind).toBe("accepted");
    expect((await pool.query("select max(generation)::int as generation from enterprise_pairings")).rows[0]?.generation).toBe(13);
    await pool.query("delete from enterprise_challenges; delete from enterprise_pairings");
    expect((await service().request(request)).kind).toBe("accepted");
    expect((await pool.query("select generation from enterprise_pairings")).rows[0]?.generation).toBe(1);
  });

  it("rolls back overflow and a deferred COMMIT failure without exposing a token", async () => {
    const request = input();
    expect((await service().request(request)).kind).toBe("accepted");
    await pool.query("update enterprise_pairings set state='expired',generation=2147483647");
    const before = (await pool.query("select coalesce(sum(used),0)::int as used from enterprise_login_budgets")).rows[0];
    expect(await service().request(request)).toEqual({ kind: "unavailable" });
    expect((await pool.query("select coalesce(sum(used),0)::int as used from enterprise_login_budgets")).rows[0]).toEqual(before);
    await pool.query(`create function fs11_commit_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic commit failure'; end$$;
      create constraint trigger fs11_commit_failure after insert on enterprise_pairings deferrable initially deferred
      for each row execute function fs11_commit_failure()`);
    try {
      expect(await service().request(input())).toEqual({ kind: "unavailable" });
      expect((await pool.query("select count(*)::int as count from enterprise_pairings")).rows[0]?.count).toBe(1);
    } finally { await pool.query("drop trigger fs11_commit_failure on enterprise_pairings; drop function fs11_commit_failure()"); }
  });

  it("does not report database or persistent activation failures as an unknown alias", async () => {
    await pool.query("update enterprise_policy set activation_state='maintenance'");
    expect(await service().request(input("unknown"))).toEqual({ kind: "unavailable" });
    expect(await totals()).toEqual({ pairings: 0, jobs: 0, identity_budgets: 0 });
    expect((await pool.query("select count(*)::int as count from enterprise_login_budgets")).rows[0]?.count).toBe(0);
    expect(await service({ expectation: { ...expectation, ownerFingerprint: "wrong" } }).request(input())).toEqual({ kind: "unavailable" });
  });

  it("copies fixed factory authority and rejects empty or excessive identifiers", async () => {
    const config = options(); const pairing = createEnterprisePairingService(config);
    Reflect.set(config, "tenantKey", "changed"); Reflect.set(config, "appId", "changed");
    const result = await pairing.request(input()); expect(result.kind).toBe("accepted");
    expect((await pool.query("select intended_identity_id from enterprise_pairings")).rows[0]?.intended_identity_id).toBe("fs11-identity");
    for (const value of ["", " ", "x".repeat(257)]) expect(() => service({ tenantKey: value })).toThrow("INVALID_ENTERPRISE_PAIRING_CONFIG");
  });
});
