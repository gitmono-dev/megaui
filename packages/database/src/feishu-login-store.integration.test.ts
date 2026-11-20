// megaui-only (FSL-146, FSL-124): the expiry cleanup of `feishu_login_codes` against a one-shot
// PostgreSQL, with an injected clock; and the consuming transaction of verify.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFeishuLoginCodes,
  consumeFeishuLoginCode,
  feishuLoginCodeHmac,
  recordFeishuLoginSession,
  FEISHU_LOGIN_CODE_RETENTION_SECONDS,
} from "./feishu-login-store";
import { createIsolatedPostgres, type IsolatedPostgres } from "./test-support/isolated-pg";

type State = "reserved" | "active" | "consumed" | "void";

interface Row {
  id: string;
  flow_hash: string;
  flow_seq: number;
  email_hmac: string;
  email_seq: number;
  state: State;
  email: string | null;
  open_id: string | null;
  display_name: string | null;
  code_hmac: string | null;
  failed_attempts: number;
  expires_at: Date;
  created_at: Date;
}

/** The injected clock of every case: a fixed instant, unrelated to the database clock. */
const NOW = new Date("2026-11-18T08:00:00.000Z");
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const RETENTION_MS = FEISHU_LOGIN_CODE_RETENTION_SECONDS * SECOND;

const hex = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe("feishu login code cleanup (FSL-146)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let second: Pool;
  /** Every inserted row as it was right after the insert. */
  const snapshots = new Map<string, Row>();

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
    second = new Pool({ connectionString: isolated.databaseUrl });
    second.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await pool.query("truncate feishu_login_codes");
    snapshots.clear();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const end of [() => pool?.end(), () => second?.end(), () => isolated?.destroy()]) {
      try {
        await end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "FSL-146 cleanup failed");
  });

  /** Inserts one row; an `active` row carries every sensitive field (FSL-119 CHECK). */
  async function insert(state: State, expiresAt: Date, createdAt: Date): Promise<string> {
    const id = randomUUID();
    const active = state === "active";
    await pool.query(
      `insert into feishu_login_codes
         (id, flow_hash, flow_seq, email_hmac, email_seq, state, email, open_id, display_name, code_hmac,
          failed_attempts, expires_at, created_at)
       values ($1, $2, 1, $3, 1, $4, $5, $6, $7, $8, 2, $9, $10)`,
      [
        id,
        hex(),
        hex(),
        state,
        active ? "alice@example.com" : null,
        active ? "ou_mock_alice" : null,
        active ? "Mock Alice" : null,
        active ? hex() : null,
        expiresAt,
        createdAt,
      ],
    );
    snapshots.set(id, (await pool.query<Row>("select * from feishu_login_codes where id = $1", [id])).rows[0]!);
    return id;
  }

  async function row(id: string): Promise<Row | undefined> {
    return (await pool.query<Row>("select * from feishu_login_codes where id = $1", [id])).rows[0];
  }

  async function count(): Promise<number> {
    return (await pool.query<{ n: number }>("select count(*)::int as n from feishu_login_codes")).rows[0]!.n;
  }

  /**
   * The row is `void` with every sensitive field cleared and every other column (order numbers,
   * HMACs, attempts, times) exactly as inserted.
   */
  async function expectVoided(id: string): Promise<void> {
    const inserted = snapshots.get(id);
    expect(inserted).toBeDefined();
    expect(await row(id)).toEqual({
      ...inserted,
      state: "void",
      email: null,
      open_id: null,
      display_name: null,
      code_hmac: null,
    });
  }

  it("AC1: an expired reserved row turns void", async () => {
    const created = at(-3 * 60 * SECOND);
    const expires = at(-60 * SECOND);
    const id = await insert("reserved", expires, created);
    // A reservation expiring at exactly the injected instant is expired as well.
    const edge = await insert("reserved", NOW, created);

    expect(await cleanupFeishuLoginCodes(pool, { now: NOW })).toEqual({ voided: 2, deleted: 0 });

    await expectVoided(id);
    await expectVoided(edge);
  });

  it("AC2: an expired active row turns void with its sensitive fields cleared", async () => {
    const created = at(-8 * 60 * SECOND);
    const expires = at(-SECOND);
    const id = await insert("active", expires, created);
    // An active code expiring at exactly the injected instant is expired as well.
    const edge = await insert("active", NOW, created);
    expect(await row(id)).toMatchObject({ state: "active", email: "alice@example.com" });
    expect(await row(edge)).toMatchObject({ state: "active", email: "alice@example.com" });

    expect(await cleanupFeishuLoginCodes(pool, { now: NOW })).toEqual({ voided: 2, deleted: 0 });

    await expectVoided(id);
    await expectVoided(edge);
  });

  it("AC3: rows created more than 24 hours ago are deleted, whatever their state", async () => {
    const stale = at(-RETENTION_MS - SECOND);
    const old = {
      reserved: await insert("reserved", at(-RETENTION_MS + 119 * SECOND), stale),
      // An active row this old is impossible in practice; it is deleted, never only voided.
      active: await insert("active", at(-RETENTION_MS + 300 * SECOND), stale),
      consumed: await insert("consumed", at(-RETENTION_MS + 300 * SECOND), stale),
      void: await insert("void", at(-RETENTION_MS + 300 * SECOND), stale),
    };
    // Created exactly 24 hours ago, or one second later: kept (only an expired one is voided).
    const edge = await insert("consumed", at(-RETENTION_MS + 300 * SECOND), at(-RETENTION_MS));
    const young = await insert("void", at(-RETENTION_MS + 301 * SECOND), at(-RETENTION_MS + SECOND));

    expect(await cleanupFeishuLoginCodes(pool, { now: NOW })).toEqual({ voided: 0, deleted: 4 });

    for (const id of Object.values(old)) expect(await row(id)).toBeUndefined();
    expect(await row(edge)).toEqual(snapshots.get(edge));
    expect(await row(young)).toEqual(snapshots.get(young));
    expect(await count()).toBe(2);
  });

  it("AC4: an unexpired active row is left as it is (and so is an unexpired reservation)", async () => {
    const active = await insert("active", at(SECOND), at(-60 * SECOND));
    const reserved = await insert("reserved", at(119 * SECOND), at(-SECOND));
    const before = { active: await row(active), reserved: await row(reserved) };
    // Rows that are no longer reserved or active are never voided again by the expiry.
    const consumed = await insert("consumed", at(-HOUR), at(-HOUR - 300 * SECOND));
    const voided = await insert("void", at(-HOUR), at(-HOUR - 120 * SECOND));

    expect(await cleanupFeishuLoginCodes(pool, { now: NOW })).toEqual({ voided: 0, deleted: 0 });

    expect(await row(active)).toEqual(before.active);
    expect(before.active).toMatchObject({ state: "active", email: "alice@example.com", open_id: "ou_mock_alice" });
    expect(await row(reserved)).toEqual(before.reserved);
    expect(await row(consumed)).toEqual(snapshots.get(consumed));
    expect(await row(voided)).toEqual(snapshots.get(voided));
  });

  it("decides against the database clock by default and against the injected clock when given", async () => {
    // Relative to the host clock, which the container's clock follows within far less than an hour.
    const real = Date.now();
    const expired = await insert("active", new Date(real - HOUR), new Date(real - HOUR - 300 * SECOND));
    const live = await insert("active", new Date(real + HOUR), new Date(real - 60 * SECOND));

    expect(await cleanupFeishuLoginCodes(pool)).toEqual({ voided: 1, deleted: 0 });
    expect(await row(expired)).toMatchObject({ state: "void", email: null });
    expect(await row(live)).toMatchObject({ state: "active" });

    // The same live row is expired for an injected instant two hours ahead.
    expect(await cleanupFeishuLoginCodes(pool, { now: new Date(real + 2 * HOUR) })).toEqual({ voided: 1, deleted: 0 });
    expect(await row(live)).toMatchObject({ state: "void", email: null });

    await expect(cleanupFeishuLoginCodes(pool, { now: new Date(Number.NaN) })).rejects.toThrow(
      "INVALID_FEISHU_LOGIN_CLEANUP_NOW",
    );
  });

  /** Waits until `count` backends wait for a row lock of the table, i.e. cleanups are blocked. */
  async function lockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and query like '%feishu_login_codes%'`,
      );
      if (waiting.rows[0]!.n >= count) return;
      if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${waiting.rows[0]!.n}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Runs `work` on a connection holding the row locks of `ids` in an open transaction. */
  async function holding<T>(ids: string[], work: (commit: (change?: string) => Promise<void>) => Promise<T>): Promise<T> {
    const holder = await pool.connect();
    let open = true;
    try {
      await holder.query("begin");
      await holder.query("select 1 from feishu_login_codes where id = any($1::uuid[]) order by id for update", [ids]);
      return await work(async (change) => {
        if (change) await holder.query(change, [ids]);
        await holder.query("commit");
        open = false;
      });
    } finally {
      if (open) await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  }

  const settled = (promise: Promise<unknown>) =>
    Promise.race([promise.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 300))]);

  it("waits for a due row a login transaction holds and handles it in the same run", async () => {
    const created = at(-400 * SECOND);
    const expires = at(-SECOND);
    const id = await insert("active", expires, created);
    await holding([id], async (commit) => {
      const run = cleanupFeishuLoginCodes(pool, { now: NOW });
      await lockWaiters(1);
      expect(await settled(run)).toBe(false);
      // The login transaction ends without touching the row: the waiting run voids it.
      await commit();
      expect(await run).toEqual({ voided: 1, deleted: 0 });
    });
    await expectVoided(id);
  });

  it("re-checks a waited-for row: one consumed meanwhile is left as it is", async () => {
    const id = await insert("active", at(-SECOND), at(-400 * SECOND));
    const other = await insert("reserved", at(-SECOND), at(-200 * SECOND));
    await holding([id], async (commit) => {
      const run = cleanupFeishuLoginCodes(pool, { now: NOW });
      await lockWaiters(1);
      await commit(
        `update feishu_login_codes
            set state = 'consumed', email = null, open_id = null, display_name = null, code_hmac = null
          where id = any($1::uuid[])`,
      );
      expect(await run).toEqual({ voided: 1, deleted: 0 });
    });
    expect(await row(id)).toMatchObject({ state: "consumed", email: null });
    await expectVoided(other);
  });

  it("a lock held past the lock timeout fails the run without changing any row", async () => {
    const held = await insert("active", at(-SECOND), at(-400 * SECOND));
    const free = await insert("reserved", at(-SECOND), at(-200 * SECOND));
    await holding([held], async () => {
      await expect(cleanupFeishuLoginCodes(pool, { now: NOW, lockTimeoutMs: 200 })).rejects.toMatchObject({
        code: "55P03",
      });
    });
    expect(await row(held)).toMatchObject({ state: "active" });
    expect(await row(free)).toMatchObject({ state: "reserved" });
    // The next run, once the lock is gone, handles both.
    expect(await cleanupFeishuLoginCodes(pool, { now: NOW })).toEqual({ voided: 2, deleted: 0 });
    await expect(cleanupFeishuLoginCodes(pool, { lockTimeoutMs: 0 })).rejects.toThrow(
      "INVALID_FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT",
    );
  });

  it("is idempotent: two connections cleaning at once void and delete each row exactly once", async () => {
    const expiredReserved = await Promise.all(
      Array.from({ length: 20 }, () => insert("reserved", at(-SECOND), at(-121 * SECOND))),
    );
    const expiredActive = await Promise.all(
      Array.from({ length: 20 }, () => insert("active", at(-SECOND), at(-400 * SECOND))),
    );
    const stale = await Promise.all(
      Array.from({ length: 20 }, () => insert("void", at(-RETENTION_MS), at(-RETENTION_MS - SECOND))),
    );
    const live = await insert("active", at(HOUR), at(-SECOND));
    const due = [...expiredReserved, ...expiredActive, ...stale].sort();

    // Interleaved: a third connection holds the due row of the largest id. The first cleanup
    // locks every other due row in id order and waits for that last one; the second cleanup then
    // waits behind the first. Once the holder ends, the first handles every row and the second,
    // re-checking each row it waited for, handles none.
    const results = await holding([due[due.length - 1]!], async (commit) => {
      const first = cleanupFeishuLoginCodes(pool, { now: NOW });
      await lockWaiters(1);
      const concurrent = cleanupFeishuLoginCodes(second, { now: NOW });
      await lockWaiters(2);
      expect(await settled(first)).toBe(false);
      expect(await settled(concurrent)).toBe(false);
      await commit();
      return Promise.all([first, concurrent]);
    });
    expect(results).toEqual([
      { voided: 40, deleted: 20 },
      { voided: 0, deleted: 0 },
    ]);

    for (const id of [...expiredReserved, ...expiredActive]) {
      expect((await row(id))!).toMatchObject({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    }
    for (const id of stale) expect(await row(id)).toBeUndefined();
    expect(await row(live)).toMatchObject({ state: "active" });
    expect(await cleanupFeishuLoginCodes(second, { now: NOW })).toEqual({ voided: 0, deleted: 0 });

    // Uncontrolled: both connections at once over a fresh set; together they handle every due
    // row exactly once, neither fails, and a further run finds nothing.
    await pool.query("truncate feishu_login_codes");
    await Promise.all(Array.from({ length: 50 }, () => insert("active", at(-SECOND), at(-400 * SECOND))));
    await Promise.all(Array.from({ length: 50 }, () => insert("consumed", at(-RETENTION_MS), at(-RETENTION_MS - SECOND))));
    const together = await Promise.all([
      cleanupFeishuLoginCodes(pool, { now: NOW }),
      cleanupFeishuLoginCodes(second, { now: NOW }),
    ]);
    expect(together.reduce((sum, result) => sum + result.voided, 0)).toBe(50);
    expect(together.reduce((sum, result) => sum + result.deleted, 0)).toBe(50);
    expect(await count()).toBe(50);
    const states = await pool.query<{ state: string; n: number }>(
      `select state, count(*)::int as n from feishu_login_codes
        where email is null and open_id is null and display_name is null and code_hmac is null
        group by state`,
    );
    expect(states.rows).toEqual([{ state: "void", n: 50 }]);
    expect(
      await Promise.all([cleanupFeishuLoginCodes(pool, { now: NOW }), cleanupFeishuLoginCodes(second, { now: NOW })]),
    ).toEqual([
      { voided: 0, deleted: 0 },
      { voided: 0, deleted: 0 },
    ]);
  });
});

describe("feishu login code consumption (FSL-124)", () => {
  const KEY = new Uint8Array(randomBytes(32));
  const APP_ID = "cli_fsl124_app";
  const USER_ID = "fsl124-user";
  const OPEN_ID = "ou_fsl124_alice";
  const CODE = "A2B3C4D5";
  let isolated: IsolatedPostgres;
  let pool: Pool;

  /** The identity HMAC of the plan (the auth verify module owns it; recomputed here). */
  const openIdHmac = (openId: string) =>
    createHmac("sha256", KEY).update(`feishu-identity:v1:${APP_ID}:${openId}`, "utf8").digest("hex");

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`truncate feishu_login_codes; delete from feishu_login_sessions; delete from session;
      delete from feishu_identities; delete from "user"`);
    await pool.query(`insert into "user" (id, name, email, email_verified) values ($1, 'Alice', 'alice@example.com', true)`, [USER_ID]);
    await pool.query("insert into feishu_identities (app_id, open_id_hmac, user_id) values ($1, $2, $3)", [
      APP_ID,
      openIdHmac(OPEN_ID),
      USER_ID,
    ]);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const end of [() => pool?.end(), () => isolated?.destroy()]) {
      try {
        await end();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "FSL-124 cleanup failed");
  });

  /**
   * Inserts one row of `flowHash` at `flowSeq`; an `active` row holds the email, `openId`, the
   * name and the HMAC of `code` (FSL-119 CHECK). `expiresInMs` is relative to the database clock.
   */
  async function insertRow(
    flowHash: string,
    flowSeq: number,
    state: State,
    options: { code?: string; openId?: string; expiresInMs?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const active = state === "active";
    await pool.query(
      `insert into feishu_login_codes
         (id, flow_hash, flow_seq, email_hmac, email_seq, state, email, open_id, display_name, code_hmac,
          failed_attempts, expires_at, created_at)
       values ($1, $2, $3, $4, $3, $5, $6, $7, $8, $9, 1,
               clock_timestamp() + make_interval(secs => $10::double precision / 1000), clock_timestamp())`,
      [
        id,
        flowHash,
        flowSeq,
        hex(),
        state,
        active ? "alice@example.com" : null,
        active ? options.openId ?? OPEN_ID : null,
        active ? "Alice" : null,
        active ? feishuLoginCodeHmac(KEY, id, options.code ?? CODE) : null,
        options.expiresInMs ?? 300_000,
      ],
    );
    return id;
  }

  async function row(id: string): Promise<Row | undefined> {
    return (await pool.query<Row>("select * from feishu_login_codes where id = $1", [id])).rows[0];
  }

  function consume(flowHash: string, code = CODE, appId = APP_ID, derive = openIdHmac) {
    return consumeFeishuLoginCode(pool, { flowHash, code, otpHmacKey: KEY, appId, openIdHmac: derive });
  }

  it("AC5, AC6: consumes the matching row and clears its four sensitive fields, nothing else", async () => {
    const flowHash = hex();
    const id = await insertRow(flowHash, 1, "active");
    const before = (await row(id))!;
    const seen: string[] = [];
    const result = await consume(flowHash, CODE, APP_ID, (openId) => {
      seen.push(openId);
      return openIdHmac(openId);
    });
    expect(result).toEqual({ kind: "consumed", userId: USER_ID });
    // The binding was looked up with the HMAC of the held open_id.
    expect(seen).toEqual([OPEN_ID]);
    const after = (await row(id))!;
    expect(after.state).toBe("consumed");
    expect({ email: after.email, open_id: after.open_id, display_name: after.display_name, code_hmac: after.code_hmac })
      .toEqual({ email: null, open_id: null, display_name: null, code_hmac: null });
    expect(after).toEqual({ ...before, state: "consumed", email: null, open_id: null, display_name: null, code_hmac: null });
  });

  it("answers invalid for a consumed row and changes nothing", async () => {
    const flowHash = hex();
    const id = await insertRow(flowHash, 1, "active");
    expect((await consume(flowHash)).kind).toBe("consumed");
    const consumed = await row(id);
    expect(await consume(flowHash)).toEqual({ kind: "invalid" });
    expect(await row(id)).toEqual(consumed);
  });

  it("answers invalid for a wrong code and leaves the row as it was", async () => {
    const flowHash = hex();
    const id = await insertRow(flowHash, 1, "active");
    const before = await row(id);
    expect(await consume(flowHash, "Z9Y8X7W6")).toEqual({ kind: "invalid" });
    expect(await row(id)).toEqual(before);
  });

  /** A pool whose transaction clients record every row their statements return. */
  function recordingPool(returned: Array<Record<string, unknown>>): Pool {
    return {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property !== "query") return Reflect.get(target, property, receiver);
            return async (text: string, values?: unknown[]) => {
              const result = await target.query(text, values);
              returned.push(...(result.rows as Array<Record<string, unknown>>));
              return result;
            };
          },
        });
      },
    } as unknown as Pool;
  }

  it("answers invalid for an expired active row, reads none of its sensitive fields and leaves it as it was", async () => {
    const flowHash = hex();
    const id = await insertRow(flowHash, 1, "active", { expiresInMs: -1000 });
    const before = await row(id);
    const returned: Array<Record<string, unknown>> = [];
    expect(await consumeFeishuLoginCode(recordingPool(returned), {
      flowHash, code: CODE, otpHmacKey: KEY, appId: APP_ID, openIdHmac,
    })).toEqual({ kind: "invalid" });
    // The newest-row statement returned the row without its code HMAC, and nothing else of the
    // hold was read.
    expect(returned.filter(entry => "id" in entry)).toEqual([{ id, state: "active", live: false, code_hmac: null }]);
    for (const entry of returned) {
      for (const field of ["email", "open_id", "display_name", "code_hmac"]) expect(entry[field] ?? null).toBeNull();
    }
    expect(await row(id)).toEqual(before);
  });

  it("never reads the hold of a row that expires after the first read", async () => {
    const flowHash = hex();
    const id = await insertRow(flowHash, 1, "active");
    // A pool whose transaction client lets the row expire (through another connection) right
    // before the statement that reads the hold, and records what that statement returned.
    const holdReads: number[] = [];
    const racing = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property !== "query") return Reflect.get(target, property, receiver);
            return async (text: string, values?: unknown[]) => {
              if (typeof text === "string" && text.trimStart().startsWith("select email, open_id, display_name")) {
                await pool.query("update feishu_login_codes set expires_at = clock_timestamp() - interval '1 second' where id = $1", [id]);
                const result = await target.query(text, values);
                holdReads.push(result.rowCount ?? 0);
                return result;
              }
              return target.query(text, values);
            };
          },
        });
      },
    } as unknown as Pool;
    expect(await consumeFeishuLoginCode(racing, {
      flowHash, code: CODE, otpHmacKey: KEY, appId: APP_ID, openIdHmac,
    })).toEqual({ kind: "invalid" });
    expect(holdReads).toEqual([0]);
    const after = (await row(id))!;
    expect(after.state).toBe("active");
    expect(after.code_hmac).not.toBeNull();
  });

  it("answers invalid for a flow without rows", async () => {
    await insertRow(hex(), 1, "active");
    expect(await consume(hex())).toEqual({ kind: "invalid" });
  });

  it("only considers the row of the largest flow_seq: an older active row is never consumed", async () => {
    for (const newest of ["reserved", "void", "consumed"] as const) {
      const flowHash = hex();
      const older = await insertRow(flowHash, 1, "active");
      const before = await row(older);
      await insertRow(flowHash, 2, newest);
      expect(await consume(flowHash), newest).toEqual({ kind: "invalid" });
      expect(await row(older)).toEqual(before);
    }
    // The newest active row of a flow is the one consumed, an older one with the same code stays.
    const flowHash = hex();
    const older = await insertRow(flowHash, 1, "active");
    const newer = await insertRow(flowHash, 2, "active");
    expect(await consume(flowHash)).toEqual({ kind: "consumed", userId: USER_ID });
    expect((await row(newer))!.state).toBe("consumed");
    expect((await row(older))!.state).toBe("active");
  });

  it("rolls back when the member has no binding: the row stays active with its hold", async () => {
    for (const [openId, appId] of [["ou_fsl124_unbound", APP_ID], [OPEN_ID, "cli_other_app"]] as const) {
      const flowHash = hex();
      const id = await insertRow(flowHash, 1, "active", { openId });
      const before = await row(id);
      expect(await consume(flowHash, CODE, appId, (value) =>
        createHmac("sha256", KEY).update(`feishu-identity:v1:${appId}:${value}`, "utf8").digest("hex"),
      )).toEqual({ kind: "unbound" });
      expect(await row(id)).toEqual(before);
    }
  });

  it("rolls back and rethrows when the identity HMAC is not 64 lowercase hex", async () => {
    const flowHash = hex();
    const id = await insertRow(flowHash, 1, "active");
    const before = await row(id);
    await expect(consume(flowHash, CODE, APP_ID, () => "not-hex")).rejects.toThrow("INVALID_FEISHU_LOGIN_OPEN_ID_HMAC");
    expect(await row(id)).toEqual(before);
  });

  it("records a Feishu login session by its ID", async () => {
    await pool.query(
      `insert into session (id, token, user_id, expires_at) values ('fsl124-session', 'fsl124-token', $1, now() + interval '8 hours')`,
      [USER_ID],
    );
    await recordFeishuLoginSession(pool, "fsl124-session");
    const marks = await pool.query("select session_id from feishu_login_sessions");
    expect(marks.rows).toEqual([{ session_id: "fsl124-session" }]);
    await expect(recordFeishuLoginSession(pool, " ")).rejects.toThrow("INVALID_FEISHU_LOGIN_SESSION_ID");
  });
});
