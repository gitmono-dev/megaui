/**
 * FSM-15：复用 CLI 启动夹具。
 *
 * 直接以冻结的 Node/tsx/IPC 协议启动真实 CLI：listener 与缺省自有 callback
 * receiver 都由 port0 实际分配；调用方可传入已知 Web 的 loopback 事件 URL，
 * 此时不创建也不关闭任何调用方接收端。参数只映射到唯一的
 * `FEISHU_SIMULATOR_CALLBACK_URL`，目标最终由 CLI 侧 FSM-22 校验并固定。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The workspace root.
 *
 * The helper is loaded both by vitest and by Playwright, and Playwright
 * transpiles it as CommonJS, so the root is found by walking up from the
 * working directory instead of through `import.meta.url`.
 */
function findRepoRoot(): string {
  let current = process.cwd();
  for (;;) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const CLI_ENTRY = resolve(REPO_ROOT, "apps/feishu-mock/src/index.ts");
const CALLBACK_PATH = "/api/integrations/feishu/events";
const STARTUP_BUDGET_MS = 15_000;
const STOP_GRACE_MS = 3_000;

export interface FeishuMockRuntimeReceipt {
  schemaVersion: number;
  baseUrl: string;
  callbackUrl: string;
  appId: string;
  tenantKey: string;
  adminToken: string;
  appSecret: string;
}

export interface StartedFeishuMock {
  baseUrl: string;
  runtime: FeishuMockRuntimeReceipt;
  /** The runtime file this run created; the CLI removes it when it exits. */
  runtimeFile: string;
  /** The process id of the CLI this fixture started. */
  pid: number | undefined;
  /**
   * Puts the run back into its synthetic initial state.
   *
   * The reset cancels the callbacks of the previous generation before it
   * answers, so the caller may only clear the receiver afterwards.
   */
  reset(): Promise<void>;
  /** Releases everything this slice created, in one path for success and failure. */
  stop(): Promise<void>;
}

interface ReadyLine {
  baseUrl: string;
  runtimeFile: string;
}

export class FeishuMockStartError extends Error {
  readonly code: "mock_start_timeout" | "mock_start_exited" | "mock_start_bad_receipt" | "mock_start_health";

  constructor(code: FeishuMockStartError["code"], message: string) {
    super(message);
    this.name = "FeishuMockStartError";
    this.code = code;
  }
}

/**
 * Starts the real CLI.
 *
 * Only the frozen simulator keys reach the child, the listener and the own
 * callback receiver are both allocated on port 0, and the ready line, the
 * runtime file and the health probe have to agree within the startup budget.
 */
export async function startFeishuMock(
  options: { callbackUrl?: string } = {},
): Promise<StartedFeishuMock> {
  const receiver = options.callbackUrl === undefined ? await startReceiver() : undefined;
  const callbackUrl = options.callbackUrl ?? receiver?.url;
  const env: NodeJS.ProcessEnv = {
    FEISHU_SIMULATOR_ENABLED: "1",
    NODE_ENV: "test",
    FEISHU_SIMULATOR_PORT: "0",
  };
  if (callbackUrl !== undefined) env.FEISHU_SIMULATOR_CALLBACK_URL = callbackUrl;

  const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY], {
    cwd: REPO_ROOT,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env,
  });
  try {
    const ready = await waitForReady(child);
    const runtime = readRuntime(ready);
    await probeHealth(ready.baseUrl);
    let stopped = false;
    const reset = async (): Promise<void> => {
      const response = await fetch(`${ready.baseUrl}/__mock/reset`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtime.adminToken}`, "content-type": "application/json" },
        body: "{}",
      });
      // The HTTP API context of this call is disposed before the next step.
      await response.arrayBuffer();
      if (!response.ok) {
        throw new FeishuMockStartError("mock_start_health", `reset answered ${response.status}`);
      }
    };
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        // The old callbacks are cancelled by the reset before the receiver is
        // cleared; a failed reset must not be hidden by the cleanup.
        await reset();
      } finally {
        await closeReceiver(receiver);
        await stopProcess(child);
      }
    };
    return { baseUrl: ready.baseUrl, runtime, runtimeFile: ready.runtimeFile, pid: child.pid, reset, stop };
  } catch (error) {
    await stopProcess(child);
    await closeReceiver(receiver);
    throw error;
  }
}

async function startReceiver(): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.statusCode = 200;
      response.end("{}");
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}${CALLBACK_PATH}`, server };
}

function waitForReady(child: ChildProcess): Promise<ReadyLine> {
  return new Promise<ReadyLine>((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new FeishuMockStartError("mock_start_timeout", `cli did not report ready within ${STARTUP_BUDGET_MS}ms`));
    }, STARTUP_BUDGET_MS);
    timer.unref?.();
    const settle = (rejectWith?: Error) => {
      clearTimeout(timer);
      if (rejectWith) reject(rejectWith);
    };
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      try {
        const line = JSON.parse(stdout.slice(0, newline)) as ReadyLine;
        if (typeof line.baseUrl !== "string" || typeof line.runtimeFile !== "string") {
          throw new Error("ready line is not the frozen receipt");
        }
        settle();
        resolvePromise(line);
      } catch (error) {
        settle(new FeishuMockStartError("mock_start_bad_receipt", (error as Error).message));
      }
    });
    child.once("exit", (code) => {
      settle(
        new FeishuMockStartError(
          "mock_start_exited",
          `cli exited with ${code} before reporting ready: ${stderr}`,
        ),
      );
    });
    child.once("error", (error) => settle(error));
  });
}

function readRuntime(ready: ReadyLine): FeishuMockRuntimeReceipt {
  let parsed: FeishuMockRuntimeReceipt;
  try {
    parsed = JSON.parse(readFileSync(ready.runtimeFile, "utf8")) as FeishuMockRuntimeReceipt;
  } catch (error) {
    throw new FeishuMockStartError("mock_start_bad_receipt", `cannot read runtime file: ${(error as Error).message}`);
  }
  if (typeof parsed.schemaVersion !== "number" || parsed.baseUrl !== ready.baseUrl) {
    throw new FeishuMockStartError("mock_start_bad_receipt", "runtime file does not match the ready line");
  }
  return parsed;
}

async function probeHealth(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new FeishuMockStartError("mock_start_health", `health probe answered ${response.status}`);
  }
  const body = (await response.json()) as { ok?: unknown };
  if (body.ok !== true) {
    throw new FeishuMockStartError("mock_start_health", "health probe did not report ok");
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
  child.kill("SIGTERM");
  if (await within(exited, STOP_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (!(await within(exited, STOP_GRACE_MS))) {
    // A killed flag is not an exit; the teardown has to fail loudly.
    throw new FeishuMockStartError("mock_start_exited", "cli did not exit after SIGKILL");
  }
}

async function closeReceiver(receiver: { server: Server } | undefined): Promise<void> {
  if (receiver === undefined) return;
  await new Promise<void>((resolvePromise) => {
    receiver.server.close(() => resolvePromise());
    receiver.server.closeAllConnections?.();
  });
}

function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}
