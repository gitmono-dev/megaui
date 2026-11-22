import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MockLifecycle } from "../../src/lifecycle";
import { startMockListener, type MockListener } from "../../src/server";
import {
  createMockState,
  MOCK_DEPARTMENT_ENGINEERING,
  resetMockState,
  SYNTHETIC_USERS,
} from "../../src/state";

const REPO_ROOT = resolve(__dirname, "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/feishu-mock/src/index.ts");

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";

let listener: MockListener | undefined;
const spawned: ChildProcess[] = [];

afterEach(async () => {
  await listener?.close();
  listener = undefined;
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

function admin(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

describe("mock run lifecycle (FSM-08)", () => {
  it("restores the synthetic initial state through the registered store", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const state = listener.state;
    state.users = [];
    state.inboxes.set("ou_mock_alice", [{ messageId: "m1", receiveId: "ou_mock_alice", msgType: "text", content: "{}", createTime: "1000000" }]);

    const response = await call(listener.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { code: number; data: { generation: number } };
    expect(payload.code).toBe(0);
    expect(payload.data.generation).toBeGreaterThan(1);

    expect(state.users.map((user) => user.open_id)).toEqual(
      SYNTHETIC_USERS.map((user) => user.open_id),
    );
    expect(state.users[0]?.department_ids).toEqual([MOCK_DEPARTMENT_ENGINEERING]);
    expect(state.inboxes.size).toBe(0);
    // FSL-140: the state keeps no event ledger, before or after a reset.
    expect(state).not.toHaveProperty("events");
  });

  it("keeps the run configuration across a reset", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const before = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    await call(listener.baseUrl, "/__mock/reset", { method: "POST", headers: admin(), body: "{}" });
    const after = await call(listener.baseUrl, "/__mock/state", { headers: admin() });
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body)).toEqual(JSON.parse(before.body));
    // The admin bearer still works after the reset.
    expect(after.status).toBe(200);
  });

  it("cancels the registered tasks before the reset reports success", async () => {
    listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN });
    const lifecycle = listener.lifecycle;
    let aborted = false;
    let finished = false;
    const task = lifecycle.startTask("pending-delivery", async (context) => {
      await new Promise<void>((resolvePromise) => {
        const timer = setInterval(() => {
          if (context.aborted) {
            clearInterval(timer);
            aborted = true;
            resolvePromise();
          }
        }, 5);
      });
      finished = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const response = await call(listener.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(aborted).toBe(true);
    expect(finished).toBe(true);
    await task;
    expect(lifecycle.taskNames).toEqual([]);
  });

  it("refuses a write back from an older generation", async () => {
    const lifecycle = new MockLifecycle();
    let written = false;
    const task = lifecycle.startTask("late-delivery", async (context) => {
      await new Promise<void>((resolvePromise) => {
        const timer = setInterval(() => {
          if (context.aborted) {
            clearInterval(timer);
            resolvePromise();
          }
        }, 5);
      });
      // The task finished after the reset, so it must not write back.
      context.commit(() => {
        written = true;
      });
    });
    await lifecycle.reset();
    await task;
    expect(written).toBe(false);
    expect(lifecycle.generation).toBe(2);
  });

  it("only accepts stores and tasks through the registration interface", async () => {
    const lifecycle = new MockLifecycle();
    let resets = 0;
    lifecycle.registerStore({
      name: "synthetic-state",
      reset: () => {
        resets += 1;
      },
    });
    await lifecycle.reset();
    expect(resets).toBe(1);
    expect(() =>
      lifecycle.registerStore({
        name: "synthetic-state",
        reset: () => undefined,
      }),
    ).toThrow(/already registered/);

    const running = lifecycle.startTask("only-task", async () => undefined);
    expect(() => lifecycle.startTask("only-task", async () => undefined)).toThrow(/already registered/);
    await running;
  });

  it("restores the state only through the registered store", () => {
    const state = createMockState();
    state.users = [];
    resetMockState(state);
    expect(state.users).toHaveLength(SYNTHETIC_USERS.length);
    expect(state.departments.map((department) => department.open_department_id)).toEqual([
      "od_mock_engineering",
      "od_mock_operations",
    ]);
  });

  it("exits when the IPC channel closes and keeps running without one", async () => {
    const withIpc = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FEISHU_SIMULATOR_ENABLED: "1",
        NODE_ENV: "test",
        FEISHU_SIMULATOR_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    spawned.push(withIpc);
    await new Promise<void>((resolvePromise) => {
      withIpc.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("baseUrl")) resolvePromise();
      });
    });
    const exited = new Promise<number | null>((resolvePromise) => {
      withIpc.once("exit", (code) => resolvePromise(code));
    });
    withIpc.disconnect?.();
    const code = await Promise.race([
      exited,
      new Promise<number | null>((resolvePromise) => setTimeout(() => resolvePromise(-1), 10_000)),
    ]);
    expect(code).not.toBe(-1);
    expect(code).toBe(0);

    const withoutIpc = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FEISHU_SIMULATOR_ENABLED: "1",
        NODE_ENV: "test",
        FEISHU_SIMULATOR_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(withoutIpc);
    const ready = await new Promise<string>((resolvePromise) => {
      let stdout = "";
      withoutIpc.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) resolvePromise(stdout);
      });
    });
    expect(ready).toContain("baseUrl");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    expect(withoutIpc.exitCode).toBe(null);
    withoutIpc.kill("SIGTERM");
    await new Promise((resolvePromise) => withoutIpc.once("exit", resolvePromise));
  }, 30_000);

  it("cleans the runtime file on shutdown without touching a caller directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-lifecycle-"));
    const file = join(directory, "runtime.json");
    try {
      const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          FEISHU_SIMULATOR_ENABLED: "1",
          NODE_ENV: "test",
          FEISHU_SIMULATOR_PORT: "0",
          FEISHU_SIMULATOR_RUNTIME_FILE: file,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned.push(child);
      await new Promise<void>((resolvePromise) => {
        child.stdout?.on("data", (chunk) => {
          if (String(chunk).includes("baseUrl")) resolvePromise();
        });
      });
      expect(existsSync(file)).toBe(true);
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("exit", resolvePromise));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      expect(existsSync(file)).toBe(false);
      expect(existsSync(directory)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
