// megaui-only (FS-40): an owned host process with a private source snapshot.
// The child receives a constructed environment, never a copy of process.env.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { copyOwnedSource } from "../../helpers/owned-web";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 180_000;
const WEB_ENV_KEYS = [
  "AUTH_MODE", "DATABASE_URL", "BETTER_AUTH_URL", "APP_BASE_URL", "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_SECRET", "MEGAUI_APP_NAME", "EMAIL_PROVIDER", "EMAIL_DEFAULT_FROM",
  "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID",
  "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS", "FEISHU_TENANT_KEY", "FEISHU_APP_ID",
  "ENTERPRISE_IP_HMAC_MASTER_KEY", "ENTERPRISE_TRUSTED_PROXY_CIDRS", "E2E_BASE_URL", "E2E_SKIP_WEBSERVER",
  "FEISHU_PROVIDER", "FEISHU_SIMULATOR_ORIGIN", "FEISHU_APP_SECRET", "FEISHU_EVENT_VERIFICATION_TOKEN", "FEISHU_EVENT_ENCRYPT_KEY",
  "FEISHU_DIRECTORY_DEPARTMENT_IDS", "ENTERPRISE_OTP_HMAC_KEY", "ENTERPRISE_DELIVERY_KEY",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS",
] as const;

export type IsolatedServerCommand = (port: number) => readonly [string, ...string[]];

export interface IsolatedServerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly command?: IsolatedServerCommand;
  readonly readyPath?: string;
  readonly sourceRoot?: string;
}

export interface IsolatedServerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("isolated server did not receive a loopback port")));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function toolPath(): string {
  const source = process.env.PATH ?? "";
  return [path.dirname(process.execPath), ...source.split(path.delimiter).filter(Boolean)].join(path.delimiter);
}

/** Construct child input from an empty object and an explicit application allowlist. */
export function buildIsolatedEnvironment(
  root: string,
  explicit: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: toolPath(),
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development",
    NO_COLOR: "1",
  };
  // Tool location only (same temp root as the parent, e.g. the CI runner temp).
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
  for (const key of WEB_ENV_KEYS) {
    const value = explicit[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

class OwnedChild {
  readonly child: ChildProcess;
  readonly finished: Promise<IsolatedServerResult>;
  private stdout = "";
  private stderr = "";
  private exited = false;
  private stopTask?: Promise<void>;

  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", chunk => { this.stdout = (this.stdout + String(chunk)).slice(-2 * 1024 * 1024); });
    this.child.stderr?.on("data", chunk => { this.stderr = (this.stderr + String(chunk)).slice(-2 * 1024 * 1024); });
    this.finished = new Promise(resolve => {
      this.child.once("close", (code, signal) => {
        this.exited = true;
        resolve({ code, signal, stdout: this.stdout, stderr: this.stderr });
      });
      this.child.once("error", () => { this.exited = true; });
    });
  }

  get isExited(): boolean { return this.exited; }
  get output(): string { return this.stdout + this.stderr; }

  private groupExists(): boolean {
    if (!this.child.pid) return false;
    try { process.kill(-this.child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "darwin") {
        const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000 })
          .trim().split("\n").map(row => row.trim().split(/\s+/)).filter(row => Number(row[1]) === this.child.pid);
        if (rows.every(row => row[2]?.startsWith("Z"))) return false;
      }
      throw new Error("Unable to inspect isolated server process group", { cause: error });
    }
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new Error("Unable to stop isolated server process group", { cause: error });
    }
  }

  async stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = (async () => {
      if (this.groupExists()) this.signal("SIGTERM");
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (this.groupExists() && Date.now() < deadline) await delay(50);
      if (this.groupExists()) this.signal("SIGKILL");
      await Promise.race([
        this.finished,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("isolated server did not exit")), STOP_TIMEOUT_MS)),
      ]);
      const after = Date.now() + STOP_TIMEOUT_MS;
      while (this.groupExists() && Date.now() < after) await delay(50);
      if (this.groupExists()) throw new Error("isolated server process group remained alive");
    })();
    return this.stopTask;
  }
}

export class IsolatedServer {
  readonly root: string;
  readonly origin: string;
  readonly env: NodeJS.ProcessEnv;
  private child?: OwnedChild;
  private closed = false;
  private closeTask?: Promise<void>;
  private constructor(readonly directory: string, readonly port: number, readonly options: IsolatedServerOptions) {
    this.root = path.join(directory, "source");
    this.origin = `http://127.0.0.1:${port}`;
    this.env = buildIsolatedEnvironment(directory, options.env);
  }

  static async create(options: IsolatedServerOptions): Promise<IsolatedServer> {
    const directory = await mkdtemp(path.join(tmpdir(), "megaui-fs40-server-"));
    const owner = new IsolatedServer(directory, await availablePort(), options);
    try {
      await Promise.all([mkdir(path.join(directory, "home"), { recursive: true }), mkdir(path.join(directory, "cache"), { recursive: true })]);
      const sourceRoot = options.sourceRoot ?? REPO_ROOT;
      try {
        await access(path.join(sourceRoot, "apps/web"));
        await copyOwnedSource(sourceRoot, owner.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await cp(sourceRoot, owner.root, { recursive: true, verbatimSymlinks: true });
      }
      return owner;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private command(): readonly [string, ...string[]] {
    return this.options.command?.(this.port) ?? ["pnpm", "--filter", "@megaui/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(this.port)];
  }

  private async waitReady(child: OwnedChild): Promise<void> {
    const startDeadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < startDeadline) {
      if (child.isExited) throw new Error("isolated server exited before readiness");
      if (/Ready in \d/.test(child.output)) break;
      await delay(100);
    }
    if (child.isExited || Date.now() >= startDeadline) throw new Error("isolated server startup deadline exceeded");
    const pathName = this.options.readyPath ?? "/api/health";
    const deadline = Date.now() + HTTP_TIMEOUT_MS;
    let lastStatus = "none";
    while (Date.now() < deadline) {
      if (child.isExited) throw new Error("isolated server exited before HTTP readiness");
      try {
        const remaining = Math.max(1_000, deadline - Date.now());
        const response = await fetch(`${this.origin}${pathName}`, { signal: AbortSignal.timeout(remaining), redirect: "manual" });
        const body = await response.text();
        lastStatus = `${response.status} ${body.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted").replace(/\s+/g, " ").slice(0, 240)}`;
        if (response.status < 500) return;
      } catch { /* bounded retry */ }
      await delay(100);
    }
    throw new Error(`isolated server HTTP readiness deadline exceeded (last status ${lastStatus})`);
  }

  async start(): Promise<IsolatedServerResult> {
    if (this.closed) throw new Error("isolated server is closed");
    if (this.child && !this.child.isExited) throw new Error("isolated server is already running");
    const [command, ...args] = this.command();
    const child = new OwnedChild(command, args, this.root, this.env);
    this.child = child;
    try {
      await this.waitReady(child);
      return { code: null, signal: null, stdout: "", stderr: "" };
    } catch (error) {
      try { await child.stop(); } catch { /* Preserve the startup error; close reports cleanup separately. */ }
      throw error;
    }
  }

  async restart(): Promise<void> {
    if (!this.child) throw new Error("isolated server has not started");
    await this.child.stop();
    await this.start();
  }

  async stop(): Promise<IsolatedServerResult | undefined> {
    if (!this.child) return undefined;
    const child = this.child;
    await child.stop();
    return child.finished;
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.closeTask = (async () => {
      const failures: unknown[] = [];
      try { await this.stop(); } catch (error) { failures.push(error); }
      try {
        let removed = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < 10 && !removed; attempt += 1) {
          try { await rm(this.directory, { recursive: true, force: true }); removed = true; }
          catch (error) { lastError = error; await delay(100); }
        }
        if (!removed) throw lastError;
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "isolated server cleanup failed");
    })();
    return this.closeTask;
  }

  async hasEnvironmentFiles(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && entry.name.startsWith(".env") && entry.name !== ".env.example" && entry.name !== ".env.test.example") {
          found.push(path.relative(this.root, target));
        }
      }
    };
    await walk(this.root);
    return found.sort();
  }

  async readLaunchEnvironment(): Promise<NodeJS.ProcessEnv> {
    const launch = await readFile(path.join(this.root, "package.json"), "utf8");
    if (!launch.includes("@megaui/web")) throw new Error("isolated source snapshot is not a Web workspace");
    return { ...this.env };
  }
}

