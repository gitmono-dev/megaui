// megaui-only (FSL-154): a flow is bound to its latest request only. The reservation, run before
// the request answers, voids the newest row of the flow (whatever its email and state, unless it
// is consumed) under the flow, email and global locks, so once it has committed every earlier
// code of the flow fails verification. Checked against a one-shot PostgreSQL and a real Feishu
// Mock process; verification goes through `consumeFeishuLoginCode` of `feishu-login-store.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type QueryResult } from "pg";
import { admitProvider, type ProviderTarget } from "@megaui/core";
import {
  consumeFeishuLoginCode,
  createFeishuLoginCodeStore,
  FEISHU_LOGIN_EMAIL_LOCK_CLASS,
  FEISHU_LOGIN_FLOW_LOCK_CLASS,
  FEISHU_LOGIN_GLOBAL_BUDGET,
  FEISHU_LOGIN_GLOBAL_LOCK_CLASS,
  FEISHU_LOGIN_GLOBAL_LOCK_KEY,
  FEISHU_LOGIN_SUPERSEDE_FLOW_SQL,
  feishuLoginEmailHmac,
  feishuLoginEmailLockKey,
  feishuLoginFlowLockKey,
} from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { FEISHU_MESSAGE_PATH } from "../feishu/message";
import {
  createFeishuLoginIssuer,
  type FeishuLoginIssueLogKey,
  type FeishuLoginIssuer,
  type FeishuLoginReservation,
} from "./issue";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const ALICE = { email: "alice@example.com", openId: "ou_mock_alice" };
const BOB = { email: "bob@example.com", openId: "ou_mock_bob" };
const DAVE = { email: "dave@corp.example.com", openId: "ou_mock_dave" };
const SHARED = "shared@corp.example.com";
const UNKNOWN = "nobody@example.com";
const SITE = "https://megaui.example.test";

const ATTEMPT_TIMEOUT_MS = 1_500;
const SEARCH_PATHNAME = "/open-apis/directory/v1/employees/search";
const MESSAGE_PATHNAME = FEISHU_MESSAGE_PATH.slice(0, FEISHU_MESSAGE_PATH.indexOf("?"));

interface MockRuntime {
  baseUrl: string;
  appId: string;
  appSecret: string;
  adminToken: string;
}

interface InboxEntry {
  content: string;
}

interface CodeRow {
  id: string;
  flow_hash: string;
  flow_seq: number;
  state: string;
  email: string | null;
  open_id: string | null;
  display_name: string | null;
  code_hmac: string | null;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The next request of a path. `forward` with a hold: `arrived` fires, then it waits for
 * `release`. With `at: "request"` (the default) the request is held before it reaches the Mock;
 * with `at: "response"` it is forwarded at once, the Mock handles it (a message is delivered), and
 * only the Mock's answer to the service is held. `reply` answers without reaching the Mock.
 */
type ProxyAction =
  | { kind: "forward"; arrived?: () => void; release?: Promise<void>; at?: "request" | "response" }
  | { kind: "reply"; status: number; body: unknown };

/** One statement a recorded transaction ran: its text, parameters and affected-row count. */
interface Statement {
  text: string;
  values: unknown[];
  rowCount: number | null;
}

const flowHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const VOID_CLEARED = { state: "void", email: null, open_id: null, display_name: null, code_hmac: null };

describe("FSL-154: a flow is bound to its latest request (real Mock HTTP and PostgreSQL)", () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;
  let child: ChildProcess;
  let receiver: Server;
  let proxy: Server;
  let runtimeFile: string;
  let runtime: MockRuntime;
  let target: ProviderTarget;
  let generateCode: () => string;
  let hmacKey: Uint8Array;

  let logs: FeishuLoginIssueLogKey[];
  /** Every code generated, in order: the code of each activation. */
  let codes: string[];
  /** Every request the proxy received (any path): the Feishu calls of the service. */
  let feishuRequests: number;
  let script: Map<string, ProxyAction[]>;
  let issuer: FeishuLoginIssuer;

  const scenario = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

  function plan(pathname: string, ...actions: ProxyAction[]): void {
    script.set(pathname, [...(script.get(pathname) ?? []), ...actions]);
  }

  async function control(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(runtime.baseUrl + path, {
      method,
      headers: { authorization: "Bearer " + runtime.adminToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    const result = (await response.json()) as { data: unknown };
    if (!response.ok) throw new Error("mock control request failed");
    return result.data;
  }

  async function inbox(openId: string): Promise<InboxEntry[]> {
    const state = (await control("/__mock/state")) as { inboxes: Record<string, InboxEntry[]> };
    return state.inboxes[openId] ?? [];
  }

  async function allInboxCount(): Promise<number> {
    const state = (await control("/__mock/state")) as { inboxes: Record<string, InboxEntry[]> };
    return Object.values(state.inboxes).reduce((sum, entries) => sum + entries.length, 0);
  }

  function textOf(entry: InboxEntry): string {
    return (JSON.parse(entry.content) as { text: string }).text;
  }

  function buildIssuer(over: Pool = pool, log: (key: FeishuLoginIssueLogKey) => void = (key) => logs.push(key)): FeishuLoginIssuer {
    return createFeishuLoginIssuer({
      pool: over,
      appId: runtime.appId,
      appSecret: runtime.appSecret,
      otpHmacKey: hmacKey,
      trustedSiteUrl: SITE,
      target,
      generateCode: () => {
        const code = generateCode();
        codes.push(code);
        return code;
      },
      log,
      attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      retryBackoffMs: 10,
    });
  }

  /** The rows of one flow, in `flow_seq` order. */
  async function flowRows(flow: string): Promise<CodeRow[]> {
    return (
      await pool.query<CodeRow>(
        "select id, flow_hash, flow_seq, state, email, open_id, display_name, code_hmac " +
          "from feishu_login_codes where flow_hash = $1 order by flow_seq",
        [flow],
      )
    ).rows;
  }

  async function rowCount(): Promise<number> {
    return (await pool.query<{ n: number }>("select count(*)::int as n from feishu_login_codes")).rows[0]!.n;
  }

  /**
   * Verifies `code` in `flow` with the store's verify function. No identity binding exists in
   * this suite, so a code that matches comes back `unbound` and its transaction is rolled back
   * (the row stays as it was): `unbound` means valid, `invalid` means not accepted.
   */
  async function verifyCode(flow: string, code: string): Promise<string> {
    const result = await consumeFeishuLoginCode(pool, {
      flowHash: flow,
      code,
      otpHmacKey: hmacKey,
      appId: runtime.appId,
      openIdHmac: (openId) => createHmac("sha256", hmacKey).update("test:" + openId).digest("hex"),
    });
    return result.kind;
  }

  async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Waits until exactly `n` statements wait for an advisory lock. */
  async function waitForAdvisoryWaiters(n: number): Promise<void> {
    await waitFor(
      async () =>
        (
          await pool.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
              "and wait_event_type = 'Lock' and query like 'select pg_advisory_xact_lock%'",
          )
        ).rows[0]!.n === n,
      `${n} transaction(s) waiting for an advisory lock`,
    );
  }

  /** The advisory locks granted in this database. */
  async function grantedAdvisoryLocks(): Promise<string[]> {
    return (
      await pool.query<{ lock: string }>(
        "select classid::int8 || ':' || objid::int8 as lock from pg_locks " +
          "where locktype = 'advisory' and granted " +
          "and database = (select oid from pg_database where datname = current_database()) order by 1",
      )
    ).rows.map((row) => row.lock);
  }

  /**
   * A pool whose clients record every statement (text, parameters, affected rows), grouped by
   * transaction, and that can hold the first statement matching `pause` until `release()`.
   */
  function recordingPool(pause?: (text: string) => boolean) {
    const transactions: Statement[][] = [];
    const arrived = deferred();
    const release = deferred();
    let paused = false;
    const wrapped = {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property, receiver) {
            if (property === "query") {
              return async (text: string, values?: unknown[]) => {
                if (text === "begin") transactions.push([]);
                if (pause && !paused && pause(text)) {
                  paused = true;
                  arrived.resolve();
                  await release.promise;
                }
                const result = (await target.query(text, values)) as QueryResult;
                transactions.at(-1)?.push({ text, values: values ?? [], rowCount: result.rowCount });
                return result;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    return { pool: wrapped, transactions, arrived: arrived.promise, release: () => release.resolve() };
  }

  /** The advisory locks a recorded transaction took, in order, as `class:key`. */
  function advisoryLocksOf(statements: Statement[]): string[] {
    return statements
      .filter((statement) => statement.text.startsWith("select pg_advisory_xact_lock"))
      .map((statement) => `${String(statement.values[0])}:${String(statement.values[1])}`);
  }

  /** The statements of a recorded transaction that take a lock (advisory or row), in order. */
  function lockingStatementsOf(statements: Statement[]): string[] {
    return statements
      .filter((statement) => statement.text.startsWith("select pg_advisory_xact_lock") || /for update/.test(statement.text))
      .map((statement) => (statement.text.startsWith("select pg_advisory_xact_lock") ? `advisory ${String(statement.values[0])}` : statement.text));
  }

  const flowLock = (flow: string) => `${FEISHU_LOGIN_FLOW_LOCK_CLASS}:${feishuLoginFlowLockKey(flow)}`;
  const emailLock = (email: string) =>
    `${FEISHU_LOGIN_EMAIL_LOCK_CLASS}:${feishuLoginEmailLockKey(feishuLoginEmailHmac(hmacKey, email))}`;
  const GLOBAL_LOCK = `${FEISHU_LOGIN_GLOBAL_LOCK_CLASS}:${FEISHU_LOGIN_GLOBAL_LOCK_KEY}`;

  /** Rows of other emails and flows created `ageSeconds` ago; `void`, so they hold nothing. */
  async function seedOtherRows(count: number, ageSeconds: number): Promise<void> {
    await pool.query(
      `insert into feishu_login_codes (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at, created_at)
       select gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1,
              encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1,
              'void', clock_timestamp() - make_interval(secs => $2::int) + interval '2 minutes',
              clock_timestamp() - make_interval(secs => $2::int)
         from generate_series(1, $1::int)`,
      [count, ageSeconds],
    );
  }

  async function waitExit(ms: number): Promise<boolean> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", done);
        resolve(false);
      }, ms);
      child.once("exit", done);
    });
  }

  beforeAll(async () => {
    // The generator FSL-150 injects; engine does not depend on `@megaui/auth`, so only this test
    // borrows the module by its source path (outside this package's rootDir, TS6059).
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TS6059 only: the borrowed module is outside the engine rootDir.
    generateCode = (await import("../../../../auth/src/feishu-login/code")).generateFeishuLoginCode;
    receiver = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("{}"));
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("missing fixture receiver");
    child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "apps/feishu-mock/src/index.ts")], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        FEISHU_SIMULATOR_ENABLED: "1",
        FEISHU_SIMULATOR_PORT: "0",
        FEISHU_SIMULATOR_CALLBACK_URL: "http://127.0.0.1:" + address.port + "/api/integrations/feishu/events",
      },
    });
    child.stderr?.resume();
    const ready = await new Promise<{ baseUrl: string; runtimeFile: string }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("mock startup timeout")), 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("mock exited before ready"));
      });
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const end = output.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(output.slice(0, end)));
        } catch {
          reject(new Error("invalid mock receipt"));
        }
      });
    });
    runtimeFile = ready.runtimeFile;
    runtime = JSON.parse(readFileSync(runtimeFile, "utf8")) as MockRuntime;
    // A recording proxy in front of the Mock: every request is counted on arrival and forwarded,
    // unless the script holds it (the Mock is then "slow" to answer) or answers it itself.
    const upstream = new URL(runtime.baseUrl);
    proxy = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks);
        const pathname = (incoming.url ?? "").split("?")[0]!;
        feishuRequests += 1;
        const action: ProxyAction = script.get(pathname)?.shift() ?? { kind: "forward" };
        void (async () => {
          if (action.kind === "reply") {
            outgoing.writeHead(action.status, { "content-type": "application/json" });
            outgoing.end(JSON.stringify(action.body));
            return;
          }
          const holdResponse = action.at === "response";
          if (!holdResponse) {
            action.arrived?.();
            await action.release;
          }
          const forwarded = httpRequest(
            {
              host: upstream.hostname,
              port: upstream.port,
              method: incoming.method,
              path: incoming.url,
              headers: { ...incoming.headers, host: upstream.host },
            },
            (answer) => {
              if (!holdResponse) {
                outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
                answer.pipe(outgoing);
                return;
              }
              // The Mock has handled the request; its answer reaches the service only on release.
              const parts: Buffer[] = [];
              answer.on("data", (chunk: Buffer) => parts.push(chunk));
              answer.on("end", () => {
                void (async () => {
                  action.arrived?.();
                  await action.release;
                  outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
                  outgoing.end(Buffer.concat(parts));
                })();
              });
            },
          );
          forwarded.on("error", () => outgoing.socket?.destroy());
          forwarded.end(body);
        })();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("missing recording proxy");
    target = admitProvider({
      enabled: true,
      provider: "simulator",
      role: "test",
      nodeEnv: "test",
      simulatorOrigin: "http://127.0.0.1:" + proxyAddress.port,
    })!;
    hmacKey = Uint8Array.from(randomBytes(32));
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    pool = new Pool({ connectionString: isolated.databaseUrl });
    pool.on("error", () => {});
  }, 120_000);

  beforeEach(async () => {
    await control("/__mock/reset", {});
    await pool.query("truncate feishu_login_codes");
    logs = [];
    codes = [];
    feishuRequests = 0;
    script = new Map();
    issuer = buildIssuer();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (runtime) await control("/__mock/reset", {});
    } catch (error) {
      errors.push(error);
    }
    try {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (receiver) {
        await new Promise<void>((resolve, reject) => receiver.close((error) => (error ? reject(error) : resolve())));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!(await waitExit(10_000))) {
        child.kill("SIGKILL");
        if (!(await waitExit(3_000))) throw new Error("mock did not stop");
      }
      if (runtimeFile && existsSync(runtimeFile)) throw new Error("mock runtime file leaked");
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await isolated?.destroy();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "FSL-154 cleanup failed");
  });

  /** Runs A (Alice) to an active, delivered code in `flow`; returns its code, checked valid. */
  async function activeCodeOfAlice(flow: string): Promise<string> {
    expect(await issuer.issueFeishuLoginCode({ flowHash: flow, email: ALICE.email })).toEqual({
      status: "sent",
      send: "accepted",
    });
    const code = codes.at(-1)!;
    expect(await verifyCode(flow, code)).toBe("unbound");
    return code;
  }

  // ---------------------------------------------------------------------------------------
  // AC3 / AC6: once B's reservation of the same flow committed, A's code is invalid.
  // ---------------------------------------------------------------------------------------

  const laterRequests = [
    { name: "B is a member (hit)", email: BOB.email, delivered: { status: "sent", send: "accepted" } },
    { name: "B has no member (miss)", email: UNKNOWN, delivered: { status: "no_target" } },
    { name: "B is refused by the cooldown", email: BOB.email, cooldown: true, delivered: { status: "cooldown" } },
    { name: "B is refused by the global budget", email: BOB.email, budget: true, delivered: { status: "budget" } },
  ] as const;

  for (const later of laterRequests) {
    scenario(`AC3/AC6: A's code is invalid once B's reservation of the same flow committed (${later.name})`, async () => {
      const flow = flowHash();
      const codeA = await activeCodeOfAlice(flow);
      const [rowA] = await flowRows(flow);
      if ("cooldown" in later) {
        // B's email has a reservation of the last 60 seconds in another flow.
        expect((await issuer.reserveFeishuLoginCode({ flowHash: flowHash(), email: later.email })).status).toBe("reserved");
      }
      if ("budget" in later) await seedOtherRows(FEISHU_LOGIN_GLOBAL_BUDGET, 30);
      const rowsBefore = await rowCount();
      const requestsBefore = feishuRequests;

      // B's reservation alone (what the request endpoint awaits before its 202).
      const reservationB = await issuer.reserveFeishuLoginCode({ flowHash: flow, email: later.email });
      // The reservation made no Feishu request.
      expect(feishuRequests).toBe(requestsBefore);
      // The linearization point: A's code fails verification before B is delivered at all.
      expect(await verifyCode(flow, codeA)).toBe("invalid");
      expect((await flowRows(flow)).find((row) => row.id === rowA!.id)).toMatchObject(VOID_CLEARED);
      if ("cooldown" in later || "budget" in later) {
        // AC6: a refused reservation writes no new row; it only committed the void.
        expect(reservationB.status).toBe("cooldown" in later ? "cooldown" : "budget");
        expect(await rowCount()).toBe(rowsBefore);
        expect(await flowRows(flow)).toHaveLength(1);
      } else {
        expect(reservationB.status).toBe("reserved");
        expect(await rowCount()).toBe(rowsBefore + 1);
      }

      expect(await issuer.deliverFeishuLoginCode(reservationB)).toEqual(later.delivered);
      // Whatever B's outcome, A's code stays invalid.
      expect(await verifyCode(flow, codeA)).toBe("invalid");
      if (later.delivered.status === "sent") {
        // The newest code of the flow is B's (A's wrong-for-this-row attempt counted once).
        expect(await verifyCode(flow, codes.at(-1)!)).toBe("unbound");
      }
      // A got one message, its code only.
      const messages = await inbox(ALICE.openId);
      expect(messages).toHaveLength(1);
      expect(textOf(messages[0]!)).toContain(codeA);
    });
  }

  for (const at of ["request", "response"] as const) {
    scenario(
      `AC3: B reserved while the Mock holds A's message ${at === "request" ? "before delivering it" : "answer after delivering it"}: A's message arrives, its code is invalid`,
      async () => {
        const flow = flowHash();
        const sendArrived = deferred();
        const sendRelease = deferred();
        plan(MESSAGE_PATHNAME, { kind: "forward", at, arrived: sendArrived.resolve, release: sendRelease.promise });
        const pendingA = issuer.issueFeishuLoginCode({ flowHash: flow, email: ALICE.email });
        // A's activation has committed and its send is in flight: either not yet delivered, or
        // delivered by the Mock with the answer not yet returned to the service.
        await sendArrived.promise;
        const codeA = codes[0]!;
        expect((await flowRows(flow))[0]).toMatchObject({ state: "active", open_id: ALICE.openId });
        expect(await inbox(ALICE.openId)).toHaveLength(at === "request" ? 0 : 1);
        expect(await verifyCode(flow, codeA)).toBe("unbound");

        const reservationB = await issuer.reserveFeishuLoginCode({ flowHash: flow, email: BOB.email });
        expect(reservationB.status).toBe("reserved");
        expect(await verifyCode(flow, codeA)).toBe("invalid");

        sendRelease.resolve();
        expect(await pendingA).toEqual({ status: "sent", send: "accepted" });
        // The message arrived (before or after B's reservation): validity, not delivery, is guaranteed.
        const messages = await inbox(ALICE.openId);
        expect(messages).toHaveLength(1);
        expect(textOf(messages[0]!)).toContain(codeA);
        expect(await verifyCode(flow, codeA)).toBe("invalid");
        expect((await flowRows(flow))[0]).toMatchObject(VOID_CLEARED);

        expect(await issuer.deliverFeishuLoginCode(reservationB)).toEqual({ status: "sent", send: "accepted" });
        expect(await verifyCode(flow, codeA)).toBe("invalid");
        expect(await verifyCode(flow, codes[1]!)).toBe("unbound");
      },
    );
  }

  scenario("AC6: a refusal whose log key cannot be written still resolves: the committed void stands", async () => {
    const flow = flowHash();
    const codeA = await activeCodeOfAlice(flow);
    // B's email has a reservation of the last 60 seconds in another flow.
    expect((await issuer.reserveFeishuLoginCode({ flowHash: flowHash(), email: BOB.email })).status).toBe("reserved");
    const rowsBefore = await rowCount();
    const failingLog = buildIssuer(pool, () => {
      throw new Error("logger down");
    });
    // The refusal is answered as usual (the request endpoint would answer 202, not 503).
    expect(await failingLog.reserveFeishuLoginCode({ flowHash: flow, email: BOB.email })).toEqual({ status: "cooldown" });
    expect(await rowCount()).toBe(rowsBefore);
    expect(await verifyCode(flow, codeA)).toBe("invalid");
  });

  // ---------------------------------------------------------------------------------------
  // AC4 / AC5: A's lookup is still at the Mock when B reserves the same flow.
  // ---------------------------------------------------------------------------------------

  for (const refused of [true, false]) {
    scenario(
      `${refused ? "AC4" : "AC5"}: A's lookup is held at the Mock while B is ${refused ? "refused by the cooldown" : "admitted"}: A sends nothing`,
      async () => {
        const flow = flowHash();
        if (refused) {
          // B's email has a reservation of the last 60 seconds in another flow.
          expect((await issuer.reserveFeishuLoginCode({ flowHash: flowHash(), email: BOB.email })).status).toBe("reserved");
        }
        const searchArrived = deferred();
        const searchRelease = deferred();
        // The Mock answers A's directory search, but the answer is held from the service.
        plan(SEARCH_PATHNAME, { kind: "forward", at: "response", arrived: searchArrived.resolve, release: searchRelease.promise });
        const requestsBefore = feishuRequests;
        const reservationA = await issuer.reserveFeishuLoginCode({ flowHash: flow, email: ALICE.email });
        // The reservation made no Feishu request.
        expect(feishuRequests).toBe(requestsBefore);
        const pendingA = issuer.deliverFeishuLoginCode(reservationA);
        await searchArrived.promise;
        // While Feishu is called, no advisory lock is held.
        expect(await grantedAdvisoryLocks()).toEqual([]);

        const reservationB = await issuer.reserveFeishuLoginCode({ flowHash: flow, email: BOB.email });
        expect(reservationB.status).toBe(refused ? "cooldown" : "reserved");
        expect(await flowRows(flow)).toHaveLength(refused ? 1 : 2);
        expect((await flowRows(flow))[0]).toMatchObject(VOID_CLEARED);
        if (!refused) {
          // B's own lookup is not held: it completes and B gets its message.
          expect(await issuer.deliverFeishuLoginCode(reservationB)).toEqual({ status: "sent", send: "accepted" });
        }

        searchRelease.resolve();
        // A's reservation was voided before its activation: no code, no message.
        expect(await pendingA).toEqual({ status: "not_reserved" });
        expect(await inbox(ALICE.openId)).toHaveLength(0);
        expect(await inbox(BOB.openId)).toHaveLength(refused ? 0 : 1);
        expect(await allInboxCount()).toBe(refused ? 0 : 1);
        // A's code (generated last, for its refused activation) was never stored or sent.
        expect(codes).toHaveLength(refused ? 1 : 2);
        const codeA = codes.at(-1)!;
        const texts = [...(await inbox(ALICE.openId)), ...(await inbox(BOB.openId))].map(textOf);
        expect(texts.some((text) => text.includes(codeA))).toBe(false);
        expect((await flowRows(flow))[0]).toMatchObject(VOID_CLEARED);
      },
    );
  }

  // ---------------------------------------------------------------------------------------
  // AC7: two requests of one flow with different emails, on two connections.
  // ---------------------------------------------------------------------------------------

  async function expectAtMostOneActive(flow: string): Promise<void> {
    const stored = await flowRows(flow);
    const active = stored.filter((row) => row.state === "active");
    expect(active.length).toBeLessThanOrEqual(1);
    // The only row that may be valid is the newest one of the flow.
    if (active.length === 1) expect(active[0]!.flow_seq).toBe(Math.max(...stored.map((row) => row.flow_seq)));
  }

  scenario("AC7: concurrent requests of one flow with two emails on two connections leave at most one active row", async () => {
    const first = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
    const second = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
    first.on("error", () => {});
    second.on("error", () => {});
    try {
      const issuers = [buildIssuer(first), buildIssuer(second)];
      for (let round = 0; round < 5; round += 1) {
        await pool.query("truncate feishu_login_codes");
        const flow = flowHash();
        const results = await Promise.all([
          issuers[0]!.issueFeishuLoginCode({ flowHash: flow, email: ALICE.email }),
          issuers[1]!.issueFeishuLoginCode({ flowHash: flow, email: BOB.email }),
        ]);
        expect(results.every((result) => result.status === "sent" || result.status === "not_reserved")).toBe(true);
        expect(await flowRows(flow)).toHaveLength(2);
        await expectAtMostOneActive(flow);
      }
    } finally {
      await first.end();
      await second.end();
    }
  });

  scenario("AC7: B's reservation waits for A's activation on the flow lock, then voids A's active row", async () => {
    const flow = flowHash();
    // A's activation stops once it holds the flow and email locks, right before its row locks.
    const gate = recordingPool((text) => text.includes("(id = $1 or state = 'active')"));
    const pendingA = buildIssuer(gate.pool).issueFeishuLoginCode({ flowHash: flow, email: ALICE.email });
    await gate.arrived;
    expect((await grantedAdvisoryLocks()).sort()).toEqual([flowLock(flow), emailLock(ALICE.email)].map(toUnsigned).sort());
    const order: string[] = [];
    const reserveB = issuer.reserveFeishuLoginCode({ flowHash: flow, email: BOB.email }).then((result) => {
      order.push("B reserved");
      return result;
    });
    try {
      // B waits for the flow lock A holds.
      await waitForAdvisoryWaiters(1);
      expect(order).toEqual([]);
    } finally {
      gate.release();
    }
    expect(await pendingA).toEqual({ status: "sent", send: "accepted" });
    const reservationB = await reserveB;
    expect(reservationB.status).toBe("reserved");
    const codeA = codes[0]!;
    // A activated first and was then voided by B: A's message went out, its code is invalid.
    expect(await inbox(ALICE.openId)).toHaveLength(1);
    expect(await verifyCode(flow, codeA)).toBe("invalid");
    await expectAtMostOneActive(flow);
    expect(await issuer.deliverFeishuLoginCode(reservationB)).toEqual({ status: "sent", send: "accepted" });
    const stored = await flowRows(flow);
    expect(stored.map((row) => row.state)).toEqual(["void", "active"]);
    await expectAtMostOneActive(flow);
  });

  /** A lock string as `pg_locks` prints it (`objid` is unsigned there). */
  function toUnsigned(lock: string): string {
    const [lockClass, key] = lock.split(":");
    return `${lockClass}:${Number(key) >>> 0}`;
  }

  // ---------------------------------------------------------------------------------------
  // The void statement: always exactly the newest row, whatever came before.
  // ---------------------------------------------------------------------------------------

  for (const previous of [
    { name: "hit", email: ALICE.email, result: { status: "sent", send: "accepted" } },
    { name: "miss", email: UNKNOWN, result: { status: "no_target" } },
    { name: "several members", email: SHARED, result: { status: "no_target" } },
  ] as const) {
    scenario(`the next reservation's void statement rewrites exactly one row after a ${previous.name}`, async () => {
      const flow = flowHash();
      expect(await issuer.issueFeishuLoginCode({ flowHash: flow, email: previous.email })).toEqual(previous.result);
      const recorded = recordingPool();
      const requestsBefore = feishuRequests;
      const reservation = await buildIssuer(recorded.pool).reserveFeishuLoginCode({ flowHash: flow, email: BOB.email });
      expect(reservation.status).toBe("reserved");
      expect(feishuRequests).toBe(requestsBefore);
      // One transaction: flow lock, email lock, global lock, then the one void statement.
      expect(recorded.transactions).toHaveLength(1);
      const [reserve] = recorded.transactions;
      expect(advisoryLocksOf(reserve!)).toEqual([flowLock(flow), emailLock(BOB.email), GLOBAL_LOCK]);
      const voids = reserve!.filter((statement) => statement.text === FEISHU_LOGIN_SUPERSEDE_FLOW_SQL);
      expect(voids.map((statement) => statement.rowCount)).toEqual([1]);
      expect((await flowRows(flow)).map((row) => row.state)).toEqual(["void", "reserved"]);
    });
  }

  scenario("a reservation waiting for a verify's row lock does not rewrite the row the verify consumed", async () => {
    const flow = flowHash();
    await activeCodeOfAlice(flow);
    // Another connection holds the flow's newest row as verify does (FSL-151), then consumes it.
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from feishu_login_codes where flow_hash = $1 order by flow_seq desc limit 1 for update", [
        flow,
      ]);
      const recorded = recordingPool();
      const pending = buildIssuer(recorded.pool).reserveFeishuLoginCode({ flowHash: flow, email: BOB.email });
      // The void statement waits for that row lock, after all three advisory locks.
      await waitFor(
        async () =>
          (
            await pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname = current_database() " +
                "and wait_event_type = 'Lock' and query like 'update feishu_login_codes%'",
            )
          ).rows[0]!.n === 1,
        "the void statement waiting for the row lock",
      );
      expect((await grantedAdvisoryLocks()).sort()).toEqual(
        [flowLock(flow), emailLock(BOB.email), GLOBAL_LOCK].map(toUnsigned).sort(),
      );
      await holder.query(
        "update feishu_login_codes set state = 'consumed', email = null, open_id = null, display_name = null, " +
          "code_hmac = null where flow_hash = $1 and state = 'active'",
        [flow],
      );
      await holder.query("commit");
      expect((await pending).status).toBe("reserved");
      // Re-checked after the wait: the newest row is consumed now, so nothing is rewritten.
      const voids = recorded.transactions[0]!.filter((statement) => statement.text === FEISHU_LOGIN_SUPERSEDE_FLOW_SQL);
      expect(voids.map((statement) => statement.rowCount)).toEqual([0]);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    expect((await flowRows(flow)).map((row) => row.state)).toEqual(["consumed", "reserved"]);
    // A consumed row is never rewritten: the next reservation voids the newest (reserved) row only.
    expect((await issuer.reserveFeishuLoginCode({ flowHash: flow, email: UNKNOWN })).status).toBe("reserved");
    expect((await flowRows(flow)).map((row) => row.state)).toEqual(["consumed", "void", "reserved"]);
  });

  scenario("with 1000 earlier rows in the flow the void statement still rewrites only the newest one", async () => {
    const flow = flowHash();
    // 1000 rows of this flow, two hours old (outside the cooldown and budget windows); the newest
    // one is an unexpired reservation, the others are void or consumed.
    await pool.query(
      `insert into feishu_login_codes (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at, created_at)
       select gen_random_uuid(), $1::text, g, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1,
              case when g = 1000 then 'reserved' when g % 2 = 0 then 'void' else 'consumed' end,
              case when g = 1000 then clock_timestamp() + interval '1 minute' else clock_timestamp() - interval '1 hour' end,
              clock_timestamp() - interval '2 hours'
         from generate_series(1, 1000) g`,
      [flow],
    );
    const versions = async () =>
      new Map(
        (
          await pool.query<{ flow_seq: number; xmin: string }>(
            "select flow_seq, xmin::text as xmin from feishu_login_codes where flow_hash = $1",
            [flow],
          )
        ).rows.map((row) => [row.flow_seq, row.xmin]),
      );
    const before = await versions();
    const recorded = recordingPool();
    expect((await buildIssuer(recorded.pool).reserveFeishuLoginCode({ flowHash: flow, email: BOB.email })).status).toBe(
      "reserved",
    );
    const voids = recorded.transactions[0]!.filter((statement) => statement.text === FEISHU_LOGIN_SUPERSEDE_FLOW_SQL);
    expect(voids.map((statement) => statement.rowCount)).toEqual([1]);
    const after = await versions();
    // Only row 1000 got a new version; row 1001 is the new reservation.
    const rewritten = [...before].filter(([seq, xmin]) => after.get(seq) !== xmin).map(([seq]) => seq);
    expect(rewritten).toEqual([1000]);
    expect([...after.keys()].filter((seq) => !before.has(seq))).toEqual([1001]);
    const stored = await flowRows(flow);
    expect(stored.find((row) => row.flow_seq === 1000)).toMatchObject(VOID_CLEARED);
    expect(stored.find((row) => row.flow_seq === 1001)).toMatchObject({ state: "reserved" });
  });

  for (const order of ["equal", "reversed"] as const) {
    scenario(`the void follows flow_seq, not created_at (created_at ${order})`, async () => {
      const flow = flowHash();
      // Two unexpired reservations of the flow: flow_seq 2 is the newer one whatever the timestamps say.
      await pool.query(
        `insert into feishu_login_codes (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at, created_at)
         values (gen_random_uuid(), $1, 1, encode(sha256('one'::bytea), 'hex'), 1, 'reserved',
                 clock_timestamp() + interval '1 minute', $2::timestamptz),
                (gen_random_uuid(), $1, 2, encode(sha256('two'::bytea), 'hex'), 1, 'reserved',
                 clock_timestamp() + interval '1 minute', $3::timestamptz)`,
        order === "equal"
          ? [flow, "2026-11-20T00:00:00Z", "2026-11-20T00:00:00Z"]
          : [flow, "2026-11-20T00:00:10Z", "2026-11-20T00:00:00Z"],
      );
      expect((await issuer.reserveFeishuLoginCode({ flowHash: flow, email: BOB.email })).status).toBe("reserved");
      expect((await flowRows(flow)).map((row) => [row.flow_seq, row.state])).toEqual([
        [1, "reserved"],
        [2, "void"],
        [3, "reserved"],
      ]);
    });
  }

  scenario("a reservation that commits after waiting for the flow lock gets the larger flow_seq", async () => {
    const flow = flowHash();
    const store = createFeishuLoginCodeStore(pool);
    // The first reservation stops right before its commit, holding the flow lock.
    const gate = recordingPool((text) => text === "commit");
    const first = createFeishuLoginCodeStore(gate.pool).reserve({
      flowHash: flow,
      emailHmac: feishuLoginEmailHmac(hmacKey, ALICE.email),
    });
    await gate.arrived;
    const order: string[] = [];
    const second = store
      .reserve({ flowHash: flow, emailHmac: feishuLoginEmailHmac(hmacKey, BOB.email) })
      .then((result) => {
        order.push("second");
        return result;
      });
    try {
      // A different email: the second reservation waits for the flow lock only.
      await waitForAdvisoryWaiters(1);
      expect(order).toEqual([]);
    } finally {
      gate.release();
    }
    const [firstResult, secondResult] = (await Promise.all([first, second])) as Array<{ kind: string; id: string }>;
    expect(firstResult!.kind).toBe("reserved");
    expect(secondResult!.kind).toBe("reserved");
    const stored = await flowRows(flow);
    expect(stored.map((row) => [row.id, row.flow_seq, row.state])).toEqual([
      [firstResult!.id, 1, "void"],
      [secondResult!.id, 2, "reserved"],
    ]);
  });

  // ---------------------------------------------------------------------------------------
  // The write-back of a delivery takes the same locks whatever the Feishu result was.
  // ---------------------------------------------------------------------------------------

  const outcomes = [
    { name: "hit", email: ALICE.email, result: { status: "sent", send: "accepted" } },
    { name: "miss", email: UNKNOWN, result: { status: "no_target" } },
    { name: "several members", email: SHARED, result: { status: "no_target" } },
    { name: "not in office", email: DAVE.email, result: { status: "inactive" } },
    { name: "provider failure", email: BOB.email, result: { status: "provider_failed" } },
  ] as const;

  scenario("every delivery writes back under the flow lock, then the email lock, with the same locking statements", async () => {
    await control("/__mock/users/" + DAVE.openId, { status: "suspended" }, "PATCH");
    const shapes: string[][][] = [];
    for (const outcome of outcomes) {
      const flow = flowHash();
      if (outcome.name === "provider failure") {
        plan(SEARCH_PATHNAME, { kind: "reply", status: 500, body: { code: 1, msg: "internal error" } });
      }
      const recorded = recordingPool();
      const service = buildIssuer(recorded.pool);
      const reservation: FeishuLoginReservation = await service.reserveFeishuLoginCode({ flowHash: flow, email: outcome.email });
      expect(reservation.status).toBe("reserved");
      expect(await service.deliverFeishuLoginCode(reservation)).toEqual(outcome.result);
      // reserve, then the delivery start, then the write-back (activation or void).
      expect(recorded.transactions).toHaveLength(3);
      const [reserve, start, writeBack] = recorded.transactions;
      expect(advisoryLocksOf(reserve!)).toEqual([flowLock(flow), emailLock(outcome.email), GLOBAL_LOCK]);
      expect(advisoryLocksOf(start!)).toEqual([flowLock(flow), emailLock(outcome.email)]);
      expect(advisoryLocksOf(writeBack!)).toEqual([flowLock(flow), emailLock(outcome.email)]);
      shapes.push([lockingStatementsOf(start!), lockingStatementsOf(writeBack!)]);
    }
    // Hit, miss, several members, not in office and provider failure: one locking shape.
    for (const shape of shapes.slice(1)) expect(shape).toEqual(shapes[0]);
    expect(logs.filter((key) => key !== "FEISHU_LOGIN_SEND_ATTEMPT")).toEqual([
      "FEISHU_LOGIN_NO_TARGET",
      "FEISHU_LOGIN_NO_TARGET",
      "FEISHU_LOGIN_INACTIVE",
      "FEISHU_LOGIN_PROVIDER_FAILED",
    ]);
  });
});
