// megaui-only (FS-88): Web + Mock + worker + two collab + SMTP composition.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createIsolatedSmtp, type IsolatedSmtp } from "../../../../../packages/email/src/test-support/isolated-smtp";
import { startFeishuMock, type StartedFeishuMock } from "./feishu-mock";
import { createEnterpriseWebFixture, type EnterpriseWebFixture } from "./enterprise-fixture";
import { projectSimulatorRuntime, containsAdminToken, type SimulatorRuntimeProjection } from "./enterprise-env";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const STOP_TIMEOUT_MS = 10_000;

export interface ManagedProcess {
  readonly pid: number | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly port?: number;
  readonly stop: () => Promise<void>;
}

class ChildOwner implements ManagedProcess {
  readonly pid: number | undefined;
  readonly env: NodeJS.ProcessEnv;
  private readonly child: ChildProcess;
  private output = "";
  private exited = false;
  private stopTask?: Promise<void>;
  constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv, readonly port?: number) {
    this.env = env;
    this.child = spawn(command, args, { cwd: REPO_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.pid = this.child.pid;
    this.child.stdout?.on("data", chunk => { this.output = (this.output + String(chunk)).slice(-512 * 1024); });
    this.child.stderr?.on("data", chunk => { this.output = (this.output + String(chunk)).slice(-512 * 1024); });
    this.child.once("close", () => { this.exited = true; });
  }
  text(): string { return this.output; }
  private groupExists(): boolean {
    if (!this.pid) return false;
    try { process.kill(-this.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }
  async stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = (async () => {
      if (this.groupExists()) process.kill(-this.pid!, "SIGTERM");
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (this.groupExists() && Date.now() < deadline) await delay(50);
      if (this.groupExists()) process.kill(-this.pid!, "SIGKILL");
      while (!this.exited && Date.now() < deadline + STOP_TIMEOUT_MS) await delay(50);
      if (this.groupExists() || !this.exited) throw new Error("FS88 child process did not exit");
    })();
    return this.stopTask;
  }
}

function hostEnvironment(explicit: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME, NODE_ENV: "test", NO_COLOR: "1", ...explicit };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!port) throw new Error("FS88 did not allocate a loopback port");
  return port;
}

async function waitForHttp(url: string, child: ChildOwner): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.text().includes("ERROR:")) throw new Error("FS88 child failed during startup");
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }); await response.body?.cancel(); if (response.ok) return; }
    catch { /* bounded retry */ }
    await delay(100);
  }
  throw new Error("FS88 child HTTP readiness deadline exceeded");
}

async function startCollab(label: string): Promise<ChildOwner> {
  const port = await availablePort();
  const env = hostEnvironment({ MEGA_COLLAB_PORT: String(port), MEGA_COLLAB_BIND: "127.0.0.1", MEGA_COLLAB_INTERNAL_TOKEN: `fs88-${label}-internal`, MEGA_COLLAB_QUIET: "1" });
  const child = new ChildOwner(process.execPath, ["--import", "tsx", "apps/collab-server/src/index.ts"], env, port);
  await waitForHttp(`http://127.0.0.1:${port}/health`, child);
  return child;
}

async function startWorker(database: EnterpriseWebFixture): Promise<ChildOwner> {
  const admin = database.admin;
  const role = `fs88_worker_${database.database.runId}`;
  const password = `fs88-${database.database.runId}-password`;
  const dbName = decodeURIComponent(new URL(database.database.databaseUrl).pathname.slice(1)).replaceAll('"', '""');
  await admin.pool.query(`create role "${role}" login password '${password}';
    revoke create on schema public from public;
    revoke create on database "${dbName}" from public;
    grant connect on database "${dbName}" to "${role}";
    grant usage on schema public to "${role}";
    grant select,insert,update,delete on all tables in schema public to "${role}";
    grant usage,select on all sequences in schema public to "${role}"`);
  const workerUrl = new URL(database.database.databaseUrl);
  workerUrl.username = role; workerUrl.password = password;
  const env = hostEnvironment({
    DATABASE_URL: workerUrl.toString(), AUTH_MODE: "enterprise", ENTERPRISE_PROCESS_ROLE: "worker",
    ENTERPRISE_OWNER_FINGERPRINT: "fs40-owner", ENTERPRISE_DB_INSTANCE_ID: database.database.runId,
    ENTERPRISE_DEPLOYMENT_ROLE: "test",
  });
  const child = new ChildOwner(process.execPath, ["--import", "tsx", "packages/engine/src/workers/enterprise.ts"], env);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.text().includes("enterprise worker") && child.text().includes("started")) return child;
    if (child.text().includes("ERROR:")) throw new Error("FS88 enterprise worker failed during startup");
    await delay(100);
  }
  throw new Error("FS88 enterprise worker startup deadline exceeded");
}

export interface EnterpriseRuntimeFixture {
  readonly web: EnterpriseWebFixture;
  readonly mock: StartedFeishuMock;
  readonly worker: ManagedProcess;
  readonly collab: readonly ManagedProcess[];
  readonly smtp: IsolatedSmtp;
  readonly projection: SimulatorRuntimeProjection;
  readonly adminToken: string;
  readonly close: () => Promise<void>;
}

export async function createEnterpriseRuntimeFixture(): Promise<EnterpriseRuntimeFixture> {
  const web = await createEnterpriseWebFixture("enterprise");
  let mock: StartedFeishuMock | undefined;
  let worker: ChildOwner | undefined;
  const collab: ChildOwner[] = [];
  let smtp: IsolatedSmtp | undefined;
  try {
    mock = await startFeishuMock({ callbackUrl: `${web.origin}/api/integrations/feishu/events` });
    const runtime = JSON.parse(await readFile(mock.runtimeFile, "utf8")) as Record<string, unknown>;
    const projection = projectSimulatorRuntime(runtime);
    Object.assign(web.server.env, projection);
    await web.restart();
    worker = await startWorker(web);
    collab.push(await startCollab("one"), await startCollab("two"));
    smtp = await createIsolatedSmtp(web.database.runId);
    const adminToken = mock.runtime.adminToken;
    if (containsAdminToken(web.server.env, adminToken) || containsAdminToken(worker.env, adminToken)
      || collab.some(child => containsAdminToken(child.env, adminToken))) throw new Error("FS88 admin token entered a child environment");
    const ownedMock = mock; const ownedWorker = worker; const ownedSmtp = smtp;
    return {
      web, mock: ownedMock, worker: ownedWorker, collab: Object.freeze([...collab]), smtp: ownedSmtp,
      projection, adminToken,
      close: async () => {
        const failures: unknown[] = [];
        try { await ownedSmtp.close(); } catch (error) { failures.push(error); }
        for (const process of [ownedWorker, ...collab].reverse()) { try { await process.stop(); } catch (error) { failures.push(error); } }
        try { await ownedMock.stop(); } catch (error) { failures.push(error); }
        try { await web.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "FS88 runtime fixture cleanup failed");
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    for (const process of [worker, ...collab].filter((value): value is ChildOwner => value !== undefined).reverse()) { try { await process.stop(); } catch (failure) { failures.push(failure); } }
    try { await smtp?.close(); } catch (failure) { failures.push(failure); }
    try { await mock?.stop(); } catch (failure) { failures.push(failure); }
    try { await web.close(); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], "FS88 runtime fixture setup/cleanup failed", { cause: error });
    throw error;
  }
}

