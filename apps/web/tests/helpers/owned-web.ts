// megaui-only (FS-92): actual Next tests own their source, database and processes.
// No real .env is copied or loaded; children never execute from the user checkout.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { performance } from "node:perf_hooks";

import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUTPUT_DIRS = new Set([".git", ".libra", ".turbo", ".next", ".pnpm-store", ".cache", ".vite", "coverage", "dist", "test-results", "playwright-report"]);
const START_TIMEOUT = 120_000;
const BUILD_TIMEOUT = 240_000;
const HTTP_TIMEOUT = 180_000;
const STOP_TIMEOUT = 10_000;
const STORAGE_IMAGE = "rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff";
const STORAGE_INIT_IMAGE = "rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699";
const STORAGE_LABEL = "dev.megaui.owned-web";
const COPY_CONCURRENCY = 4;
type StorageResource = { kind: "container" | "volume" | "network"; name: string; creationSettled: boolean };

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function actualEnvironmentFile(name: string): boolean {
  return name.startsWith(".env") && name !== ".env.test.example" && name !== ".env.example";
}

type CopyTask = { readonly source: string; readonly destination: string };
type CopyPartition = { readonly destination: string; readonly mode: number };
type CopyPlan = { readonly tasks: CopyTask[]; readonly partitions: CopyPartition[] };
export interface OwnedCopyObserver {
  readonly onTaskStart?: () => void | Promise<void>;
  readonly onTaskEnd?: () => void | Promise<void>;
  readonly onPhase?: (phase: "enumerate" | "copy" | "scan" | "launcher" | "links" | "restore", milliseconds: number) => void | Promise<void>;
}

async function timedCopyPhase<T>(observer: OwnedCopyObserver | undefined, phase: Parameters<NonNullable<OwnedCopyObserver["onPhase"]>>[0], work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await work(); }
  finally { await observer?.onPhase?.(phase, performance.now() - started); }
}

function shouldCopy(sourceRoot: string, source: string): boolean {
  const relative = path.relative(sourceRoot, source);
  const parts = relative ? relative.split(path.sep) : [];
  const name = path.basename(source);
  if (actualEnvironmentFile(name) || name.endsWith(".tsbuildinfo")) return false;
  if (!parts.includes("node_modules") && OUTPUT_DIRS.has(name)) return false;
  return !(parts.includes("node_modules") && [".cache", ".vite", ".tmp"].includes(name));
}

async function assertPrivateDirectoryRoot(root: string, label: string): Promise<void> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function runBounded<T>(tasks: readonly T[], work: (task: T) => Promise<void>, signal?: AbortSignal, observer?: OwnedCopyObserver): Promise<void> {
  let next = 0;
  let failed = false;
  const failures: unknown[] = [];
  const worker = async () => {
    while (true) {
      if (failed) return;
      if (signal?.aborted) {
        failed = true;
        failures.push(signal.reason ?? new Error("Owned source copy aborted"));
        return;
      }
      const task = tasks[next++];
      if (task === undefined) return;
      try {
        await observer?.onTaskStart?.();
        await work(task);
      }
      catch (error) { failed = true; failures.push(error); }
      finally {
        try { await observer?.onTaskEnd?.(); }
        catch (error) { failed = true; failures.push(error); }
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(COPY_CONCURRENCY, Math.max(tasks.length, 1)) }, worker));
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, "Owned source copy failed", { cause: failures[0] });
}

async function enumerateCopyTasks(sourceRoot: string, destinationRoot: string): Promise<CopyPlan> {
  const tasks: CopyTask[] = [];
  const partitions: CopyPartition[] = [];
  const nodeModules = path.join(sourceRoot, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const partition = async (source: string, destination: string): Promise<void> => {
    const sourceMode = (await lstat(source)).mode & 0o7777;
    await mkdir(destination, { recursive: true, mode: sourceMode | 0o200 });
    await chmod(destination, sourceMode | 0o200);
    partitions.push({ destination, mode: sourceMode });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const child = path.join(source, entry.name);
      const target = path.join(destination, entry.name);
      if (!shouldCopy(sourceRoot, child)) continue;
      if (entry.isDirectory() && (source === sourceRoot || source === nodeModules) &&
          (child === nodeModules || child === pnpmStore)) {
        await partition(child, target);
      } else {
        tasks.push({ source: child, destination: target });
      }
    }
  };
  await assertPrivateDirectoryRoot(sourceRoot, "Owned source root");
  await mkdir(destinationRoot, { recursive: true });
  await partition(sourceRoot, destinationRoot);
  return { tasks, partitions };
}

async function scanCopiedTree(root: string): Promise<{ links: string[]; launchers: string[] }> {
  const links: string[] = [];
  const launchers: string[] = [];
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) links.push(relative);
      else if (entry.isDirectory()) await scan(target);
      else if (entry.isFile() && relative.split(path.sep).includes(".bin")) launchers.push(relative);
    }
  };
  await scan(root);
  return { links, launchers };
}

export async function copyOwnedSource(sourceRoot: string, destinationRoot: string, signal?: AbortSignal, observer?: OwnedCopyObserver): Promise<void> {
  await assertPrivateDirectoryRoot(sourceRoot, "Owned source root");
  await assertPrivateDirectoryRoot(path.dirname(destinationRoot), "Owned destination parent");
  const sourceRealRoot = await realpath(sourceRoot);
  const destinationParentReal = await realpath(path.dirname(destinationRoot));
  if (within(sourceRealRoot, destinationParentReal)) throw new Error("Owned destination must be outside source root");
  try {
    await assertPrivateDirectoryRoot(destinationRoot, "Owned destination root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(destinationRoot, { recursive: false });
  }
  const plan = await timedCopyPhase(observer, "enumerate", () => enumerateCopyTasks(sourceRoot, destinationRoot));
  let operationError: unknown;
  try {
    const copyFilter = (source: string): boolean => shouldCopy(sourceRoot, source);
    await timedCopyPhase(observer, "copy", () => runBounded(plan.tasks, async ({ source, destination }) => {
      await cp(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
        filter: copyFilter,
      });
    }, signal, observer));
    if (signal?.aborted) throw signal.reason ?? new Error("Owned source copy aborted");

    const { links, launchers } = await timedCopyPhase(observer, "scan", () => scanCopiedTree(destinationRoot));
    const originalRoots = new Set([sourceRoot, await realpath(sourceRoot)]);
    await timedCopyPhase(observer, "launcher", () => runBounded(launchers, async relative => {
      const target = path.join(destinationRoot, relative);
      let source = await readFile(target, "utf8");
      for (const original of originalRoots) source = source.replaceAll(original, destinationRoot);
      await writeFile(target, source);
    }, signal));
    const realRoot = await realpath(destinationRoot);
    await timedCopyPhase(observer, "links", async () => {
      await runBounded(links, async relative => {
        const resolved = await realpath(path.join(destinationRoot, relative));
        if (!within(realRoot, resolved)) throw new Error("Owned Web dependency link escapes source copy");
      }, signal);
      const workspaceRoot = path.join(realRoot, "packages");
      for (const entry of await readdir(path.join(destinationRoot, "apps/web/node_modules/@megaui"))) {
        const resolved = await realpath(path.join(destinationRoot, "apps/web/node_modules/@megaui", entry));
        if (!within(workspaceRoot, resolved)) throw new Error("Owned Web workspace dependency is not copied");
      }
    });
  } catch (error) {
    operationError = error;
  }
  const restoreErrors: unknown[] = [];
  await timedCopyPhase(observer, "restore", async () => {
    for (const { destination, mode } of [...plan.partitions].reverse()) {
      try { await chmod(destination, mode); }
      catch (error) { restoreErrors.push(error); }
    }
  });
  if (operationError && restoreErrors.length) throw new AggregateError([operationError, ...restoreErrors], "Owned source copy and permission restore failed", { cause: operationError });
  if (operationError) throw operationError;
  if (restoreErrors.length) throw new AggregateError(restoreErrors, "Owned source permission restore failed", { cause: restoreErrors[0] });
}

async function withinDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned Web port allocation failed");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

export interface OwnedCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** In-memory diagnostics only. Never print arbitrary child output or auth payloads. */
  readonly stdout: string;
  readonly stderr: string;
}

const commandDiagnostics = new WeakMap<Error, OwnedCommandResult>();
export class OwnedCommandError extends Error {
  constructor(result: OwnedCommandResult) {
    super(`Owned Web command failed (exit ${result.code ?? result.signal ?? "unknown"})`);
    commandDiagnostics.set(this, result);
  }
}
/** Explicit diagnostic access; test reporters cannot enumerate raw child output. */
export function readOwnedCommandDiagnostics(error: unknown): OwnedCommandResult | undefined {
  return error instanceof Error ? commandDiagnostics.get(error) : undefined;
}

class OwnedProcess {
  readonly child: ChildProcess;
  readonly finished: Promise<OwnedCommandResult>;
  private stopResult?: Promise<void>;
  private spawnFailed = false;
  private exited = false;
  private stdout = "";
  private stderr = "";

  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // Diagnostics are bounded and kept private, including on failed mint/E2E runs.
    this.child.stdout?.on("data", (chunk) => { this.stdout = (this.stdout + String(chunk)).slice(-2 * 1024 * 1024); });
    this.child.stderr?.on("data", (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-2 * 1024 * 1024); });
    this.finished = new Promise((resolve) => {
      this.child.once("error", () => { this.spawnFailed = true; });
      this.child.once("close", (code, signal) => {
        this.exited = true;
        resolve({ code, signal, stdout: this.stdout, stderr: this.stderr });
      });
    });
  }

  get isExited() { return this.exited || this.spawnFailed; }
  get isListening() { return /Ready in \d/.test(this.stdout); }
  get enterpriseInitializationFailed() { return (this.stdout + this.stderr).includes("ENTERPRISE_WEB_UNAVAILABLE"); }

  private groupExists(): boolean {
    if (!this.child.pid) return false;
    try { process.kill(-this.child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // Darwin can return EPERM for an existing group containing only zombies.
      // Confirm process metadata; never treat a live permission failure as exit.
      if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "darwin") {
        const metadata = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024 });
        const members = metadata.trim().split("\n").map((row) => row.trim().split(/\s+/))
          .filter((row) => Number(row[1]) === this.child.pid);
        if (members.every((row) => row[2]?.startsWith("Z"))) return false;
      }
      throw new Error(`Cannot inspect owned Web process group ${this.child.pid}`, { cause: error });
    }
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code === "EPERM" && !this.groupExists()) return;
      throw new Error(`Cannot stop owned Web process group ${this.child.pid}`, { cause: error });
    }
  }

  stop(deadline = Date.now() + 3 * STOP_TIMEOUT): Promise<void> {
    if (this.stopResult) return this.stopResult;
    const task = (async () => {
      if (this.groupExists()) this.signal("SIGTERM");
      const until = Math.min(deadline, Date.now() + STOP_TIMEOUT);
      while (this.groupExists() && Date.now() < until) await delay(50);
      if (this.groupExists()) this.signal("SIGKILL");
      // The actual child exit is required, not merely a successful signal syscall.
      if (Date.now() >= deadline) throw new Error("Owned Web process stop deadline exceeded");
      await withinDeadline(this.finished, Math.min(STOP_TIMEOUT, deadline - Date.now()), "Owned Web child did not exit after termination");
      const killedUntil = Math.min(deadline, Date.now() + STOP_TIMEOUT);
      while (this.groupExists() && Date.now() < killedUntil) await delay(50);
      if (this.groupExists()) throw new Error("Owned Web process group did not exit");
    })();
    this.stopResult = task;
    // Keep the owner on failure, allowing final cleanup to inspect/stop it again.
    void task.catch(() => { if (this.stopResult === task) this.stopResult = undefined; });
    return task;
  }
}

export class OwnedWeb {
  readonly root: string;
  readonly baseURL: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly processes = new Set<OwnedProcess>();
  private readonly dockerProcesses = new Set<OwnedProcess>();
  private readonly filesystemOperations = new Set<Promise<unknown>>();
  private database?: IsolatedPostgres;
  private readonly databaseObservers = new Set<DatabaseClient>();
  private storage?: { run: string; resources: StorageResource[]; setup: Promise<void> };
  private closeResult?: Promise<void>;
  private closed = false;

  private constructor(readonly directory: string, readonly port: number) {
    this.root = path.join(directory, "source");
    this.baseURL = `http://127.0.0.1:${port}`;
    // PATH, HOME and TMPDIR are tool locations only; do not inherit application settings,
    // NODE_OPTIONS, NODE_PATH, PGOPTIONS, provider credentials or proxy variables.
    const toolPath = (process.env.PATH ?? "").split(path.delimiter)
      .filter((entry) => entry && !within(SOURCE_ROOT, path.resolve(entry)));
    this.env = {
      HOME: process.env.HOME,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      PATH: [path.dirname(process.execPath), ...toolPath].join(path.delimiter),
      NODE_ENV: "test", CI: "true", NO_COLOR: "1", NEXT_TELEMETRY_DISABLED: "1",
      MEGAUI_APP_NAME: "megaui", AUTH_MODE: "legacy", EMAIL_PROVIDER: "test",
      EMAIL_DEFAULT_FROM: "noreply@example.com",
      BETTER_AUTH_SECRET: "owned-web-synthetic-secret-at-least-32-bytes",
      BETTER_AUTH_URL: this.baseURL, APP_BASE_URL: this.baseURL,
      BETTER_AUTH_TRUSTED_ORIGINS: this.baseURL,
      E2E_BASE_URL: this.baseURL, E2E_SKIP_WEBSERVER: "1",
    };
  }

  static async create(signal?: AbortSignal): Promise<OwnedWeb> {
    signal?.throwIfAborted();
    // Register the directory before allocating any later resource, including ports.
    const directory = await mkdtemp(path.join(tmpdir(), "megaui-owned-web-"));
    let owner: OwnedWeb | undefined;
    try {
      owner = new OwnedWeb(directory, await availablePort());
      signal?.throwIfAborted();
      const preparing = owner;
      // FIX-FS-02: migrations use this module's source, not the pending copy.
      // Join both real terminal results even on failure/abort before cleanup;
      // an early rejection must not leave a late directory or database behind.
      const outcomes = await Promise.allSettled([
        preparing.copySource(signal),
        (async () => {
          preparing.database = await createIsolatedPostgres();
          signal?.throwIfAborted();
          preparing.env.DATABASE_URL = preparing.database.databaseUrl;
          await preparing.database.migrate();
          signal?.throwIfAborted();
        })(),
      ]);
      const failures = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Owned Web preparation failed", { cause: failures[0] });
      signal?.throwIfAborted();
      return owner;
    } catch (error) {
      try {
        if (owner) await owner.close();
        else await rm(directory, { recursive: true, force: true });
      } catch (cleanup) { throw new AggregateError([error, cleanup], "Owned Web setup and cleanup failed", { cause: cleanup }); }
      throw error;
    }
  }

  private async copySource(signal?: AbortSignal): Promise<void> {
    await copyOwnedSource(SOURCE_ROOT, this.root, signal);
  }

  private filesystemWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Owned Web is closed"));
    const task = Promise.resolve().then(work);
    this.filesystemOperations.add(task);
    void task.then(() => this.filesystemOperations.delete(task), () => this.filesystemOperations.delete(task));
    return task;
  }

  writeTestFile(relative: string, source: string): Promise<void> {
    return this.filesystemWork(async () => {
      const target = path.resolve(this.root, relative);
      if (!within(this.root, target) || actualEnvironmentFile(path.basename(target))) throw new Error("Invalid owned test path");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    });
  }

  private spawn(command: string, args: readonly string[], overrides: Partial<NodeJS.ProcessEnv> = {}): OwnedProcess {
    if (this.closed) throw new Error("Owned Web is closed");
    const child = new OwnedProcess(command, args, this.root, { ...this.env, ...overrides });
    this.processes.add(child);
    return child;
  }

  async run(command: string, args: readonly string[], timeoutMs = START_TIMEOUT, overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<OwnedCommandResult> {
    const child = this.spawn(command, args, overrides);
    let result: OwnedCommandResult;
    try {
      result = await withinDeadline(child.finished, timeoutMs, "Owned Web command exceeded its deadline");
    } catch (error) {
      try { await child.stop(); this.processes.delete(child); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Owned Web command and cleanup failed", { cause: cleanup }); }
      throw error;
    }
    await child.stop();
    this.processes.delete(child);
    if (result.code !== 0) throw new OwnedCommandError(result);
    return result;
  }

  async build(timeoutMs = BUILD_TIMEOUT): Promise<void> {
    await this.run("pnpm", ["--filter", "@megaui/web", "run", "build"], timeoutMs, { NODE_ENV: "production" });
  }

  /** FS-93: privileged fixture/observation connection, separate from the Web DML URL. */
  createDatabaseObserver(): DatabaseClient {
    this.checkOpen();
    if (!this.database) throw new Error("Owned database is not initialized");
    const observer = createDatabaseClient({ connectionString: this.database.databaseUrl,
      connectionTimeoutMillis: 1000, statementTimeoutMillis: 3000,
      onPoolError: () => { /* Query/cleanup failures remain observable without credential logs. */ } });
    this.databaseObservers.add(observer);
    return observer;
  }

  /** Only the existing Roam upload spec needs actual, run-owned object storage. */
  provisionObjectStorage(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Owned Web is closed"));
    if (this.storage) return this.storage.setup;
    const state = { run: randomUUID(), resources: [] as StorageResource[], setup: Promise.resolve() };
    this.storage = state;
    state.setup = this.initializeObjectStorage(state);
    return state.setup;
  }

  private checkOpen(): void {
    if (this.closed) throw new Error("Owned Web is closed");
  }

  // Docker mutations finish within their own deadline even when close begins.
  // Killing a CLI cannot cancel a daemon request: a failed/timed-out creation
  // remains uncertain and cleanup must report it, including after an empty list.
  private async docker(args: readonly string[], timeoutMs = 30_000): Promise<OwnedCommandResult> {
    const deadline = Date.now() + timeoutMs;
    const child = new OwnedProcess("docker", args, this.root, this.env);
    this.dockerProcesses.add(child);
    let result: OwnedCommandResult;
    try { result = await withinDeadline(child.finished, timeoutMs, "Owned storage command deadline exceeded"); }
    catch (error) {
      try { await child.stop(deadline); this.dockerProcesses.delete(child); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Owned storage command cleanup failed", { cause: cleanup }); }
      throw error;
    }
    await child.stop(deadline);
    this.dockerProcesses.delete(child);
    if (Date.now() >= deadline) throw new Error("Owned storage command deadline exceeded");
    if (result.code !== 0) throw new OwnedCommandError(result);
    return result;
  }

  private async initializeObjectStorage(state: NonNullable<OwnedWeb["storage"]>): Promise<void> {
    for (const image of [STORAGE_IMAGE, STORAGE_INIT_IMAGE]) {
      this.checkOpen();
      try { await this.run("docker", ["image", "inspect", image]); }
      catch (error) {
        if (!(error instanceof OwnedCommandError)) throw error;
        await this.run("docker", ["pull", image], 120_000);
        await this.run("docker", ["image", "inspect", image]);
      }
    }
    const prefix = `megaui-web-${state.run}`;
    const network = `${prefix}-net`;
    const volume = `${prefix}-data`;
    const server = `${prefix}-s3`;
    const initializer = `${prefix}-init`;
    const bucket = `owned-${state.run}`;
    const accessKey = "ownedweb";
    const secretKey = `owned-web-${state.run}`;
    const label = `${STORAGE_LABEL}=${state.run}`;
    const create = async (kind: StorageResource["kind"], name: string, args: string[]) => {
      this.checkOpen();
      const resource = { kind, name, creationSettled: false };
      state.resources.push(resource); // Register intent before sending anything.
      await this.docker(args);
      resource.creationSettled = true;
      this.checkOpen();
    };
    await create("network", network, ["network", "create", "--label", label, network]);
    await create("volume", volume, ["volume", "create", "--label", label, volume]);
    await create("container", server, ["create", "--name", server, "--label", label,
      "--network", network, "--network-alias", "storage", "--publish", "127.0.0.1::9000",
      "--mount", `type=volume,source=${volume},target=/data`,
      "--env", "RUSTFS_VOLUMES=/data", "--env", "RUSTFS_ADDRESS=0.0.0.0:9000",
      "--env", "RUSTFS_CONSOLE_ENABLE=false", "--env", "RUSTFS_UNSAFE_BYPASS_DISK_CHECK=true",
      "--env", `RUSTFS_ACCESS_KEY=${accessKey}`, "--env", `RUSTFS_SECRET_KEY=${secretKey}`, STORAGE_IMAGE]);
    await this.docker(["start", server], 120_000);
    this.checkOpen();
    const mapped = await this.docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "9000/tcp")}}', server]);
    const ports: unknown = JSON.parse(mapped.stdout);
    if (!Array.isArray(ports) || ports.length !== 1 || ports[0]?.HostIp !== "127.0.0.1"
      || !/^\d+$/.test(ports[0]?.HostPort)) throw new Error("Owned storage did not bind loopback");
    const origin = `http://127.0.0.1:${ports[0].HostPort}`;
    const deadline = Date.now() + HTTP_TIMEOUT;
    let ready = false;
    while (Date.now() < deadline) {
      this.checkOpen();
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch { /* Only the loopback mapping of our created container is probed. */ }
      await delay(100);
    }
    if (!ready) throw new Error("Owned storage HTTP readiness deadline exceeded");
    await create("container", initializer, ["create", "--name", initializer, "--label", label,
      "--network", network, "--entrypoint", "/bin/sh", STORAGE_INIT_IMAGE, "-c",
      `/usr/bin/rc alias set local http://storage:9000 ${accessKey} ${secretKey} && /usr/bin/rc mb local/${bucket} && /usr/bin/rc anonymous set download local/${bucket}`]);
    await this.docker(["start", "--attach", initializer], 120_000);
    this.checkOpen();
    const status = await this.docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", initializer]);
    if (status.stdout.trim() !== "exited 0") throw new Error("Owned storage bucket initialization failed");
    Object.assign(this.env, { S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: accessKey,
      S3_ACCESS_KEY_SECRET: secretKey, S3_BUCKET: bucket, S3_ENDPOINT: origin,
      S3_PUBLIC_URL: `${origin}/${bucket}`, S3_FORCE_PATH_STYLE: "true" });
  }

  private async removeObjectStorage(): Promise<void> {
    if (!this.storage) return;
    const state = this.storage;
    const deadline = Date.now() + 60_000;
    const remaining = new Set(state.resources);
    const inspect = async (kind: StorageResource["kind"]) => {
      const args = kind === "container" ? ["container", "ls", "--all"] : [kind, "ls"];
      const result = await this.docker([...args, "--filter", `label=${STORAGE_LABEL}=${state.run}`,
        "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"], Math.max(1, Math.min(10_000, deadline - Date.now())));
      return new Set(result.stdout.trim().split("\n").filter(Boolean));
    };
    // Reverse dependency order; one refusal never skips the other resource kinds.
    for (let attempt = 0; attempt < 3 && remaining.size && Date.now() < deadline; attempt += 1) {
      for (const resource of [...remaining].reverse()) {
        if (Date.now() >= deadline) break;
        try {
          const names = await inspect(resource.kind);
          if (names.has(resource.name)) {
            const args = [resource.kind, "rm", ...(resource.kind === "container" ? ["--force"] : []), resource.name];
            await this.docker(args, Math.max(1, Math.min(30_000, deadline - Date.now())));
          }
          if (!(await inspect(resource.kind)).has(resource.name)) remaining.delete(resource);
        } catch { /* Retry within the single total cleanup deadline. */ }
      }
    }
    if (remaining.size || Date.now() >= deadline) throw new Error("Owned storage cleanup failed: resource absence was not verified within its deadline");
    if (state.resources.some((resource) => !resource.creationSettled)) {
      throw new Error("Owned storage cleanup-pending: a creation request has no confirmed terminal result");
    }
  }

  async start(mode: "dev" | "standalone" = "dev"): Promise<{ stop(): Promise<void>; exit: Promise<OwnedCommandResult> }> {
    if (mode === "standalone") {
      await this.filesystemWork(async () => {
      const builtWeb = path.join(this.root, "apps/web/.next/standalone/apps/web");
      await cp(path.join(this.root, "apps/web/.next/static"), path.join(builtWeb, ".next/static"), { recursive: true });
      const publicDir = path.join(this.root, "apps/web/public");
      try { await access(publicDir); await cp(publicDir, path.join(builtWeb, "public"), { recursive: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      });
    }
    const child = mode === "dev"
      ? this.spawn("pnpm", ["--filter", "@megaui/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(this.port)], { NODE_ENV: "development" })
      : this.spawn(process.execPath, ["apps/web/.next/standalone/apps/web/server.js"], { NODE_ENV: "production", PORT: String(this.port), HOSTNAME: "127.0.0.1" });
    try {
      const startupDeadline = Date.now() + START_TIMEOUT;
      while (!child.isListening && Date.now() < startupDeadline) {
        if (child.enterpriseInitializationFailed) throw new Error("Owned Web enterprise initialization rejected");
        if (child.isExited) throw new Error("Owned Web failed to bind its own listener");
        await delay(100);
      }
      if (!child.isListening) throw new Error("Owned Web startup deadline exceeded");
      const deadline = Date.now() + HTTP_TIMEOUT;
      let lastStatus = "none";
      while (Date.now() < deadline) {
        if (child.enterpriseInitializationFailed) throw new Error("Owned Web enterprise initialization rejected");
        if (child.isExited) throw new Error("Owned Web exited before HTTP readiness");
        try {
          const remaining = Math.max(1_000, deadline - Date.now());
          const response = await fetch(`${this.baseURL}/api/health`, { signal: AbortSignal.timeout(remaining), redirect: "manual" });
          const body = await response.text();
          lastStatus = `${response.status} ${body.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted").replace(/\s+/g, " ").slice(0, 240)}`;
          const result: unknown = JSON.parse(body);
          if (response.ok && typeof result === "object" && result !== null && "status" in result && result.status === "healthy") {
            // A successful foreign listener is not proof our child bound the port.
            await delay(100);
            if (child.isExited) throw new Error("Owned Web exited before HTTP readiness");
            return { stop: async () => { await child.stop(); this.processes.delete(child); }, exit: child.finished };
          }
        } catch { /* Retry bounded HTTP readiness; no response bodies enter logs. */ }
        await delay(100);
      }
      throw new Error(`Owned Web HTTP readiness deadline exceeded (last status ${lastStatus})`);
    } catch (error) {
      try { await child.stop(); this.processes.delete(child); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Owned Web start and cleanup failed", { cause: cleanup }); }
      if (error instanceof Error) commandDiagnostics.set(error, await child.finished);
      throw error;
    }
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closeResult ??= (async () => {
      const failures: unknown[] = [];
      for (const child of this.processes) {
        try { await child.stop(); } catch (error) { failures.push(error); }
      }
      // An in-flight daemon mutation settles before names/labels are inspected.
      // Its original failure belongs to setup; uncertain creation is also a
      // cleanup failure even if the first resource inspection is empty.
      await this.storage?.setup.catch(() => undefined);
      for (const child of this.dockerProcesses) {
        try { await child.stop(); this.dockerProcesses.delete(child); } catch (error) { failures.push(error); }
      }
      // No pending copy/write may recreate a directory after removal.
      for (const result of await Promise.allSettled(this.filesystemOperations)) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      try { await this.removeObjectStorage(); } catch (error) { failures.push(error); }
      for (const child of this.dockerProcesses) {
        try { await child.stop(); this.dockerProcesses.delete(child); } catch (error) { failures.push(error); }
      }
      for (const observer of this.databaseObservers) {
        try { await withinDeadline(observer.close(), 5000, "Owned database observer cleanup pending"); }
        catch (error) { failures.push(error); }
      }
      if (this.database) {
        try { await this.database.destroy(); } catch (error) { failures.push(error); }
      }
      try { await rm(this.directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Owned Web cleanup failed");
    })();
  }
}

export async function withOwnedWeb<T>(work: (owner: OwnedWeb) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const owner = await OwnedWeb.create(signal);
  // Setup settles and registers every resource before close may remove anything.
  const abort = () => { void owner.close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await work(owner);
    signal?.throwIfAborted();
    await owner.close();
    return result;
  } catch (error) {
    try { await owner.close(); }
    catch (cleanup) {
      if (cleanup === error) throw error;
      throw new AggregateError([error, cleanup], "Owned Web test and cleanup failed", { cause: cleanup });
    }
    throw error;
  } finally { signal?.removeEventListener("abort", abort); }
}

/** FS-73: switch this owned run to the enterprise Web assembly for the pairing E2E. */
export async function installEnterprisePairingFixture(owner: OwnedWeb): Promise<void> {
  const admin = owner.createDatabaseObserver();
  const databaseUrl = owner.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Owned enterprise fixture database is unavailable");
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1)).replaceAll('"', '""');
  await admin.pool.query(`create role fs73_web login password 'synthetic-fs73-password';
    revoke create on schema public from public;
    revoke create on database "${database}" from public;
    grant connect on database "${database}" to fs73_web;
    grant usage on schema public to fs73_web;
    grant select,insert,update,delete on all tables in schema public to fs73_web;
    grant usage,select on all sequences in schema public to fs73_web;
    insert into enterprise_policy
      (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ('policy-fs73','fs73','owned','test','test','enterprise',1)`);
  const webUrl = new URL(databaseUrl);
  webUrl.username = "fs73_web";
  webUrl.password = "synthetic-fs73-password";
  Object.assign(owner.env, {
    AUTH_MODE: "enterprise",
    DATABASE_URL: webUrl.toString(),
    ENTERPRISE_PROCESS_ROLE: "web",
    ENTERPRISE_OWNER_FINGERPRINT: "owned",
    ENTERPRISE_DB_INSTANCE_ID: "fs73",
    ENTERPRISE_DEPLOYMENT_ROLE: "test",
    FEISHU_TENANT_KEY: "tenant",
    FEISHU_APP_ID: "app",
    ENTERPRISE_IP_HMAC_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    ENTERPRISE_TRUSTED_PROXY_CIDRS: "[]",
  });
  delete owner.env.ENTERPRISE_APPROVED_TARGETS;
}

// Only installed into an owned source copy. Context inputs and router observations
// are controlled; every consumer and its business callback remains the real code.
export async function installNavigationFixture(owner: OwnedWeb): Promise<void> {
  await owner.writeTestFile("apps/web/app/[lang]/owned-navigation/page.tsx", `"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathParamsContext, PathnameContext, SearchParamsContext, NavigationPromisesContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import CLFilesPage from "@/app/[lang]/workspace/cls/[n]/files/page";
import CodePathPage from "@/app/[lang]/workspace/code/[...path]/page";
import DocDetailPage from "@/app/[lang]/workspace/docs/[docId]/page";
import { DocRoamShortcuts } from "@/app/[lang]/workspace/docs/components/doc-roam-shortcuts";
import { SettingsNav } from "@/app/[lang]/workspace/settings/components/settings-nav";
import SettingsPage from "@/app/[lang]/workspace/settings/page";
const Editor = dynamic(() => import("@megaui/ui/content/editor").then((m) => m.MegaContentEditor), { ssr: false });
const options = ["cl", "code", "doc", "roam", "settings-nav", "settings"];
export default function NavigationFixture() {
  const originalRouter = useRouter();
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [consumer, setConsumer] = useState("cl");
  const [readiness, setReadiness] = useState("unknown");
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [mutations, setMutations] = useState<string[]>([]);
  useEffect(() => client.getMutationCache().subscribe(() => {
    setMutations(client.getMutationCache().getAll().map((mutation) => mutation.state.status));
  }), [client]);
  const params = readiness === "unknown" || readiness === "no-params" ? null : { lang: "en", n: "42", path: ["README%20file.md"], docId: "doc_navigation" };
  const search = useMemo(() => readiness === "unknown" || readiness === "no-search" ? null : new URLSearchParams(query), [readiness, query]);
  const pathname = readiness === "unknown" || readiness === "no-pathname" ? null : "/en/workspace/docs/doc_navigation";
  const router = { ...originalRouter,
    push: (href: string) => setEvents((all) => [...all, "push " + href]),
    replace: (href: string) => setEvents((all) => [...all, "replace " + href]),
  };
  return <main>
    <label>Consumer<select aria-label="Consumer" value={consumer} onChange={(e) => setConsumer(e.target.value)}>{options.map((name) => <option key={name}>{name}</option>)}</select></label>
    <label>Readiness<select aria-label="Readiness" value={readiness} onChange={(e) => setReadiness(e.target.value)}>{["unknown", "known", "no-params", "no-search", "no-pathname"].map((name) => <option key={name}>{name}</option>)}</select></label>
    <label>Query<input aria-label="Query" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    <button type="button" onClick={() => setEvents([])}>Clear navigation</button>
    <output data-owned="navigation">{JSON.stringify(events)}</output>
    <output data-owned="mutations">{JSON.stringify(mutations)}</output>
    <QueryClientProvider client={client}>
    <NavigationPromisesContext.Provider value={null}>
    <AppRouterContext.Provider value={router}>
    <PathParamsContext.Provider value={params}>
    <PathnameContext.Provider value={pathname}>
    <SearchParamsContext.Provider value={search}>
    <section data-owned="consumer"><Suspense fallback={<p>Loading fixture</p>}>
      {consumer === "cl" ? <CLFilesPage /> : null}
      {consumer === "code" ? <CodePathPage /> : null}
      {consumer === "doc" ? <DocDetailPage /> : null}
      {consumer === "roam" ? <Editor preset="document" placeholder="Owned editor"><DocRoamShortcuts onReferenceCreateError={() => {}} /></Editor> : null}
      {consumer === "settings-nav" ? <SettingsNav /> : null}
      {consumer === "settings" ? <SettingsPage /> : null}
    </Suspense></section>
    </SearchParamsContext.Provider>
    </PathnameContext.Provider>
    </PathParamsContext.Provider>
    </AppRouterContext.Provider>
    </NavigationPromisesContext.Provider>
    </QueryClientProvider>
  </main>;
}
`);
}

async function main(): Promise<void> {
  const [action, spec] = process.argv.slice(2);
  if (action !== "e2e" || !spec || !/^apps\/web\/tests\/e2e\/[a-z0-9-]+\.spec\.ts$/.test(spec)) {
    throw new Error("Usage: owned-web.ts e2e apps/web/tests/e2e/<spec>.spec.ts");
  }
  const controller = new AbortController();
  const onInterrupt = () => { process.exitCode = 130; controller.abort(new Error("Owned Web interrupted")); };
  const onTerminate = () => { process.exitCode = 143; controller.abort(new Error("Owned Web terminated")); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
  await withOwnedWeb(async (owner) => {
    if (spec === "apps/web/tests/e2e/navigation-readiness.spec.ts") await installNavigationFixture(owner);
    if (spec === "apps/web/tests/e2e/workspace-docs-roam.spec.ts") await owner.provisionObjectStorage();
    if (spec === "apps/web/tests/e2e/enterprise-pairing-request.spec.ts") await installEnterprisePairingFixture(owner);
    await owner.start();
    const result = await owner.run("pnpm", ["exec", "playwright", "test", spec, "--workers=1", "--trace=off"], 600_000);
    const counts = result.stdout.match(/\b\d+ (?:passed|failed|skipped)\b/g) ?? [];
    process.stdout.write(`Owned browser gate: ${counts.join(", ")}\n`);
  }, controller.signal);
  process.stdout.write("Owned Web processes, Postgres and source copy removed\n");
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const diagnostics = readOwnedCommandDiagnostics(error);
    if (diagnostics) {
      // Only static Playwright test headings and aggregate counts are reportable.
      const lines = stripVTControlCharacters(diagnostics.stdout).split("\n");
      for (const line of lines.filter((value) => /^\s+\d+\) .*\.spec\.ts:\d+:\d+/.test(value))) process.stderr.write(`${line.trim()}\n`);
      const counts = diagnostics.stdout.match(/\b\d+ (?:passed|failed|skipped)\b/g) ?? [];
      process.stderr.write(`Owned browser result: ${counts.join(", ")}\n`);
    }
    const cleanupFailed = error instanceof AggregateError && error.message.includes("cleanup");
    process.stderr.write(cleanupFailed
      ? "Owned Web gate failed: resource cleanup failed; inspect owned run resources\n"
      : "Owned Web gate failed: execution failed; owned cleanup completed\n");
    process.exitCode ||= 1;
  });
}
