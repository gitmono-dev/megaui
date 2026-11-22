/**
 * FSM-01：Mock CLI 入口。
 *
 * 只以 FSM-22 校验过的冻结配置启动：监听 127.0.0.1，生成每 run 独立的
 * 随机凭据，写入独占 runtime 文件，然后向 stdout 输出唯一一行 ready JSON。
 * 正常退出、收到 SIGINT/SIGTERM 或 IPC 通道断开时，清理本 run 创建的 runtime
 * 文件与自有目录，并中止已注册的异步任务。
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { resolveMockConfig } from "./config";
import { startMockListener, type MockListener } from "./server";
import {
  createRunSecrets,
  MOCK_APP_ID,
  MOCK_RUNTIME_SCHEMA_VERSION,
  MOCK_TENANT_KEY,
  prepareRuntimeTarget,
  removeRuntimeTarget,
  writeRuntimeFile,
  type MockRuntime,
  type MockRuntimeTarget,
} from "./state";

async function run(): Promise<void> {
  const config = resolveMockConfig(process.env);
  const target = prepareRuntimeTarget(config.runtimeFile);
  let listener: MockListener | undefined;
  let shuttingDown = false;
  // The handlers are registered before the listener starts so that a signal
  // arriving during startup still removes the runtime this process owns.
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await listener?.close();
      removeRuntimeTarget(target);
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // A run started with an IPC channel belongs to its parent: when the channel
  // closes the run cleans up and exits. The disconnect surfaces as a process
  // level event; the channel object itself does not report it. A run started
  // without a channel keeps running until it is asked to stop.
  if (process.channel) {
    process.once("disconnect", shutdown);
  }
  try {
    const secrets = createRunSecrets();
    listener = await startMockListener(config, {
      adminToken: secrets.adminToken,
      appSecret: secrets.appSecret,
    });
    const runtime: MockRuntime = {
      schemaVersion: MOCK_RUNTIME_SCHEMA_VERSION,
      baseUrl: listener.baseUrl,
      appId: MOCK_APP_ID,
      tenantKey: MOCK_TENANT_KEY,
      ...secrets,
    };
    writeRuntimeFile(target, runtime);
    process.stdout.write(`${JSON.stringify({ baseUrl: runtime.baseUrl, runtimeFile: target.file })}\n`);
  } catch (error) {
    await listener?.close();
    removeRuntimeTarget(target);
    throw error;
  }
}

export function reportStartupFailure(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    process.stderr.write(`${code}: ${(error as Error).message}\n`);
  } else {
    process.stderr.write(`mock_startup_failed: ${(error as Error).message}\n`);
  }
  process.exit(1);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entry === fileURLToPath(import.meta.url)) {
  run().catch(reportStartupFailure);
}

export type { MockRuntimeTarget };
