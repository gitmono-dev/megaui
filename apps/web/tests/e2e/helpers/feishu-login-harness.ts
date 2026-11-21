// megaui-only (FSL-129): the Feishu login E2E harness.
//
// One harness run owns, and releases on every path (ER-14):
// - an owned source copy with its one-shot PostgreSQL (FS-92 `OwnedWeb`: no real `.env`
//   is copied or loaded, migrations applied);
// - a real Feishu Mock CLI process (`apps/feishu-mock`, FSM-15 `startFeishuMock`);
// - the Web as its own `next dev` process group from that copy, in Feishu mode
//   (`AUTH_MODE=enterprise`, `AUTH_PROVIDER=feishu`, `FEISHU_PROVIDER=simulator` pointed
//   at the Mock, the Mock's app credentials and a fresh synthetic HMAC key).
//
// `startFeishuLoginHarness` releases whatever it already started when setup fails, and
// `close()` releases all three. `withFeishuLoginHarness` closes on success and when the
// work throws. `listFeishuLoginHarnessLeftovers` lets a test assert the release from the
// outside (process table, sockets, docker, filesystem). Codes read from the Mock inbox
// stay in memory and are never logged (ER-11).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { DatabaseClient } from "@megaui/database";

import { OwnedWeb } from "../../helpers/owned-web";
import { startFeishuMock, type StartedFeishuMock } from "./feishu-mock";

const execFileAsync = promisify(execFile);
const CODE_PATTERN = /验证码：([2-9A-Z]{8})/u;
const CODE_WAIT_MS = 20_000;

export type FeishuLoginHarnessStage = "database" | "mock" | "web";

/** What one harness run allocated, registered as soon as each part exists. */
export interface FeishuLoginHarnessResources {
  /** The owned source copy directory. */
  directory?: string;
  /** The one-shot PostgreSQL container and its loopback port. */
  databaseContainer?: string;
  databasePort?: number;
  /** The Feishu Mock CLI process and its listener. */
  mockPid?: number;
  mockPort?: number;
  /**
   * The Web listener port, and the process group of `next dev` (`OwnedWeb` starts it
   * detached, as its own group), read from the process listening on that port as soon as
   * a poll sees it listen, also while the start is still pending.
   */
  webPort?: number;
  webProcessGroup?: number;
}

export interface FeishuLoginHarnessOptions {
  /** Test only: fail setup right after this stage is up, to exercise the setup-failure cleanup. */
  readonly failAfter?: FeishuLoginHarnessStage;
}

export interface FeishuLoginHarness {
  /** The Web origin, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly mock: StartedFeishuMock;
  /** A privileged observer connection on the run's database, for fixtures and assertions. */
  readonly database: DatabaseClient;
  readonly resources: Readonly<FeishuLoginHarnessResources>;
  /** The number of messages the Mock has delivered to this member so far. */
  inboxSize(openId: string): Promise<number>;
  /** Waits until the member's inbox holds more than `seen` messages and returns the newest code. */
  nextCode(openId: string, seen: number): Promise<string>;
  close(): Promise<void>;
}

export class FeishuLoginHarnessSetupError extends Error {
  constructor(readonly resources: Readonly<FeishuLoginHarnessResources>, options: { cause: unknown }) {
    super("Feishu login harness setup failed", options);
    this.name = "FeishuLoginHarnessSetupError";
  }
}

/** The isolated PG container is `megaui-pg-<runId>`, its database `<prefix>_<runId>`. */
function databaseResources(databaseUrl: string): Pick<FeishuLoginHarnessResources, "databaseContainer" | "databasePort"> {
  const url = new URL(databaseUrl);
  const runId = /_([0-9a-f]{12})$/.exec(decodeURIComponent(url.pathname.slice(1)))?.[1];
  if (!runId) throw new Error("the owned database name carries no run id");
  return { databaseContainer: `megaui-pg-${runId}`, databasePort: Number(url.port) };
}

/** The process group of the process listening on `port`, or undefined while nothing listens. */
async function listenerProcessGroup(port: number): Promise<number | undefined> {
  let pids: string;
  try {
    pids = (await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 })).stdout;
  } catch (error) {
    // lsof exits 1 when nothing listens; any other failure is real.
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
  const pid = pids.trim().split("\n")[0];
  if (!pid) return undefined;
  const { stdout } = await execFileAsync("/bin/ps", ["-o", "pgid=", "-p", pid], { timeout: 5_000 });
  const group = Number(stdout.trim());
  return Number.isInteger(group) && group > 0 ? group : undefined;
}

/**
 * Waits for the Web start and records the `next dev` process group, polling the listener
 * every 250 ms while the start is pending, so a start that fails after a listener was seen
 * is still identified. A listener that comes and goes between two polls is not recorded;
 * that case relies on `OwnedWeb.start`, which stops its group before it rejects.
 */
async function recordWebProcessGroup(
  resources: FeishuLoginHarnessResources,
  port: number,
  starting: Promise<unknown>,
): Promise<void> {
  let settled = false;
  const outcome = starting.then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
  while (!settled && resources.webProcessGroup === undefined) {
    resources.webProcessGroup = await listenerProcessGroup(port).catch(() => undefined);
    if (resources.webProcessGroup === undefined) await Promise.race([outcome, delay(250)]);
  }
  const failure = await outcome;
  if (failure !== undefined) throw failure;
  resources.webProcessGroup ??= await listenerProcessGroup(port);
  if (resources.webProcessGroup === undefined) throw new Error("the Web listener has no process group");
}

export async function startFeishuLoginHarness(options: FeishuLoginHarnessOptions = {}): Promise<FeishuLoginHarness> {
  const resources: FeishuLoginHarnessResources = {};
  let owner: OwnedWeb | undefined;
  let mock: StartedFeishuMock | undefined;
  let database: DatabaseClient | undefined;
  const failAfter = (stage: FeishuLoginHarnessStage) => {
    if (options.failAfter === stage) throw new Error(`injected harness failure after ${stage}`);
  };
  const release = async (): Promise<void> => {
    const failures: unknown[] = [];
    // The Web (and with it the PG and the source copy) first: it is the Mock's only client.
    try { await owner?.close(); } catch (error) { failures.push(error); }
    try { await mock?.stop(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Feishu login harness cleanup failed");
  };

  try {
    owner = await OwnedWeb.create();
    resources.directory = owner.directory;
    Object.assign(resources, databaseResources(owner.env.DATABASE_URL!));
    failAfter("database");

    mock = await startFeishuMock();
    resources.mockPid = mock.pid;
    resources.mockPort = Number(new URL(mock.baseUrl).port);
    failAfter("mock");

    Object.assign(owner.env, {
      AUTH_MODE: "enterprise",
      AUTH_PROVIDER: "feishu",
      FEISHU_PROVIDER: "simulator",
      FEISHU_SIMULATOR_ORIGIN: mock.baseUrl,
      FEISHU_APP_ID: mock.runtime.appId,
      FEISHU_APP_SECRET: mock.runtime.appSecret,
      ENTERPRISE_OTP_HMAC_KEY: randomBytes(32).toString("base64url"),
    });
    resources.webPort = owner.port;
    const starting = owner.start("dev");
    await recordWebProcessGroup(resources, owner.port, starting);
    database = owner.createDatabaseObserver();
    failAfter("web");
  } catch (error) {
    try { await release(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Feishu login harness setup and cleanup failed", { cause: cleanup }); }
    throw new FeishuLoginHarnessSetupError(resources, { cause: error });
  }

  const started = { owner: owner!, mock: mock!, database: database! };
  let closing: Promise<void> | undefined;

  const inboxes = async (): Promise<Record<string, Array<{ content: string }>>> => {
    const response = await fetch(`${started.mock.baseUrl}/__mock/state`, {
      headers: { authorization: `Bearer ${started.mock.runtime.adminToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`the Mock state answered ${response.status}`);
    return ((await response.json()) as { data: { inboxes: Record<string, Array<{ content: string }>> } }).data.inboxes;
  };

  return {
    origin: started.owner.baseURL,
    mock: started.mock,
    database: started.database,
    resources,
    inboxSize: async openId => ((await inboxes())[openId] ?? []).length,
    nextCode: async (openId, seen) => {
      const deadline = Date.now() + CODE_WAIT_MS;
      while (Date.now() < deadline) {
        const inbox = (await inboxes())[openId] ?? [];
        if (inbox.length > seen) {
          const text = (JSON.parse(inbox[inbox.length - 1]!.content) as { text?: unknown }).text;
          const match = typeof text === "string" ? CODE_PATTERN.exec(text) : null;
          if (!match) throw new Error("the delivered message carries no code");
          return match[1]!;
        }
        await delay(100);
      }
      throw new Error("no code reached the Mock inbox");
    },
    close: () => (closing ??= release()),
  };
}

/** Runs `work` on a fresh harness and closes it whether `work` resolves or throws. */
export async function withFeishuLoginHarness<T>(
  work: (harness: FeishuLoginHarness) => Promise<T>,
  options: FeishuLoginHarnessOptions = {},
): Promise<T> {
  const harness = await startFeishuLoginHarness(options);
  let result: T;
  try {
    result = await work(harness);
  } catch (error) {
    try { await harness.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Feishu login harness work and cleanup failed", { cause: cleanup }); }
    throw error;
  }
  await harness.close();
  return result;
}

function refused(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", error => resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED"));
  });
}

/** The live (non-zombie) members of a process group, from the process table. */
async function groupMembers(group: number): Promise<string[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim().split("\n").map(row => row.trim().split(/\s+/))
    .filter(row => Number(row[1]) === group && !row[2]?.startsWith("Z"))
    .map(row => row[0]!);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * What of a run is still present, checked from the outside: the source copy on disk, the
 * PG container in docker, the Mock process and any live member of the Web process group in
 * the process table, and any listener on the run's PG, Mock or Web port. An empty list means everything was released.
 */
export async function listFeishuLoginHarnessLeftovers(resources: Readonly<FeishuLoginHarnessResources>): Promise<string[]> {
  const leftovers: string[] = [];
  if (resources.directory !== undefined) {
    try { await access(resources.directory); leftovers.push("source copy directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") leftovers.push("source copy directory (unreadable)"); }
  }
  if (resources.databaseContainer !== undefined) {
    const { stdout } = await execFileAsync("docker", [
      "ps", "--all", "--filter", `name=^/${resources.databaseContainer}$`, "--format", "{{.Names}}",
    ], { timeout: 15_000 });
    if (stdout.trim() !== "") leftovers.push("PostgreSQL container");
  }
  if (resources.databasePort !== undefined && !(await refused(resources.databasePort))) leftovers.push("PostgreSQL listener");
  if (resources.mockPid !== undefined && processAlive(resources.mockPid)) leftovers.push("Mock process");
  if (resources.mockPort !== undefined && !(await refused(resources.mockPort))) leftovers.push("Mock listener");
  if (resources.webPort !== undefined && !(await refused(resources.webPort))) leftovers.push("Web listener");
  if (resources.webProcessGroup !== undefined && (await groupMembers(resources.webProcessGroup)).length > 0) {
    leftovers.push("Web process group");
  }
  return leftovers;
}
