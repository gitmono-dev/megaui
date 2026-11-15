import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRunSecrets,
  MOCK_APP_ID,
  MOCK_RUNTIME_SCHEMA_VERSION,
  MOCK_TENANT_KEY,
  prepareRuntimeTarget,
  removeRuntimeTarget,
  writeRuntimeFile,
  type MockRuntime,
} from "../../src/state";

const REPO_ROOT = resolve(__dirname, "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/feishu-mock/src/index.ts");

interface ReadyLine {
  baseUrl: string;
  runtimeFile: string;
}

const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function startCli(env: Record<string, string>, onReady?: (ready: ReadyLine) => void): {
  child: ChildProcess;
  ready: Promise<ReadyLine>;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const ready = new Promise<ReadyLine>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`cli did not report ready: ${stderr}`)), 30_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      resolvePromise(JSON.parse(stdout.slice(0, newline)) as ReadyLine);
      onReady?.(JSON.parse(stdout.slice(0, newline)) as ReadyLine);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cli exited with ${code} before reporting ready: ${stderr}`));
    });
  });
  return { child, ready, stdout: () => stdout, stderr: () => stderr };
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code));
  });
}

function get(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const call = request(`${baseUrl}${path}`, { method: "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += String(chunk);
      });
      response.on("end", () => {
        resolvePromise({ status: response.statusCode ?? 0, body });
      });
    });
    call.on("error", reject);
    call.end();
  });
}

describe("mock CLI runtime (FSM-01)", () => {
  it("starts only with a validated configuration", async () => {
    const { child, stderr, ready } = startCli({
      FEISHU_SIMULATOR_ENABLED: "0",
      NODE_ENV: "test",
    });
    ready.catch(() => undefined);
    const code = await waitForExit(child);
    expect(code).not.toBe(0);
    expect(stderr()).toContain("simulator_disabled");
  });

  it("reports one ready line without secrets and writes the runtime file", async () => {
    const { child, ready, stdout } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    expect(Object.keys(line).sort()).toEqual(["baseUrl", "runtimeFile"]);
    expect(line.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stdout().trimEnd().split("\n")).toHaveLength(1);

    const runtime = JSON.parse(readFileSync(line.runtimeFile, "utf8")) as MockRuntime;
    expect(runtime.schemaVersion).toBe(MOCK_RUNTIME_SCHEMA_VERSION);
    expect(runtime.baseUrl).toBe(line.baseUrl);
    expect(runtime.callbackUrl).toBe("http://127.0.0.1:3000/api/integrations/feishu/events");
    expect(runtime.appId).toBe(MOCK_APP_ID);
    expect(runtime.tenantKey).toBe(MOCK_TENANT_KEY);
    for (const secret of [
      "appSecret",
      "verificationToken",
      "encryptKey",
      "adminToken",
    ] as const) {
      expect(typeof runtime[secret]).toBe("string");
      expect(runtime[secret].length).toBeGreaterThan(0);
    }
    expect(runtime.adminToken).not.toBe(runtime.appSecret);

    const readyLine = stdout();
    for (const secret of [
      "appSecret",
      "verificationToken",
      "encryptKey",
      "adminToken",
    ] as const) {
      expect(readyLine).not.toContain(runtime[secret]);
    }
    expect(readyLine).not.toContain(runtime.callbackUrl);
    child.kill("SIGTERM");
  });

  it("creates the runtime directory 0700 and the runtime file 0600", async () => {
    const { child, ready } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    const directory = resolve(line.runtimeFile, "..");
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(line.runtimeFile).mode & 0o777).toBe(0o600);
    child.kill("SIGTERM");
  });

  it("generates independent credentials per run", async () => {
    const first = createRunSecrets();
    const second = createRunSecrets();
    expect(first.appSecret).not.toBe(second.appSecret);
    expect(first.verificationToken).not.toBe(second.verificationToken);
    expect(first.encryptKey).not.toBe(second.encryptKey);
    expect(first.adminToken).not.toBe(second.adminToken);
  });

  it("generates independent credentials across real CLI runs", async () => {
    const runtimes: MockRuntime[] = [];
    for (let index = 0; index < 2; index += 1) {
      const { child, ready } = startCli({
        FEISHU_SIMULATOR_ENABLED: "1",
        NODE_ENV: "test",
        FEISHU_SIMULATOR_PORT: "0",
      });
      const line = await ready;
      runtimes.push(JSON.parse(readFileSync(line.runtimeFile, "utf8")) as MockRuntime);
      child.kill("SIGTERM");
      await waitForExit(child);
    }
    expect(runtimes[0]?.appSecret).not.toBe(runtimes[1]?.appSecret);
    expect(runtimes[0]?.verificationToken).not.toBe(runtimes[1]?.verificationToken);
    expect(runtimes[0]?.encryptKey).not.toBe(runtimes[1]?.encryptKey);
    expect(runtimes[0]?.adminToken).not.toBe(runtimes[1]?.adminToken);
  });

  it("never writes a generated secret to stderr", async () => {
    const { child, ready, stderr } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    const runtime = JSON.parse(readFileSync(line.runtimeFile, "utf8")) as MockRuntime;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    const output = stderr();
    for (const secret of [
      "appSecret",
      "verificationToken",
      "encryptKey",
      "adminToken",
    ] as const) {
      expect(output).not.toContain(runtime[secret]);
    }
    child.kill("SIGTERM");
  });

  it("answers 404 for routes no earlier card delivers", async () => {
    const { child, ready } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    const response = await get(line.baseUrl, "/not-delivered");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: 4, msg: "not_found" });
    child.kill("SIGTERM");
  });

  it("refuses to overwrite an existing runtime file and leaves it untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-test-"));
    const file = join(directory, "runtime.json");
    try {
      writeFileSync(file, "{\"kept\":true}\n");
      const { child, ready, stderr } = startCli({
        FEISHU_SIMULATOR_ENABLED: "1",
        NODE_ENV: "test",
        FEISHU_SIMULATOR_PORT: "0",
        FEISHU_SIMULATOR_RUNTIME_FILE: file,
      });
      ready.catch(() => undefined);
      const code = await waitForExit(child);
      expect(code).not.toBe(0);
      expect(stderr()).toContain("mock_runtime_file_exists");
      expect(readFileSync(file, "utf8")).toBe("{\"kept\":true}\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked runtime target and leaves the link target untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-test-"));
    const file = join(directory, "runtime.json");
    const link = join(directory, "link.json");
    try {
      writeFileSync(file, "{\"kept\":true}\n");
      symlinkSync(file, link);
      const { child, ready, stderr } = startCli({
        FEISHU_SIMULATOR_ENABLED: "1",
        NODE_ENV: "test",
        FEISHU_SIMULATOR_PORT: "0",
        FEISHU_SIMULATOR_RUNTIME_FILE: link,
      });
      ready.catch(() => undefined);
      const code = await waitForExit(child);
      expect(code).not.toBe(0);
      expect(stderr()).toContain("mock_runtime_file_symlink");
      expect(readFileSync(file, "utf8")).toBe("{\"kept\":true}\n");
      expect(existsSync(link)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing runtime file", () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-test-"));
    try {
      const file = join(directory, "runtime.json");
      writeFileSync(file, "{}\n");
      expect(() => prepareRuntimeTarget(file)).toThrow(/already exists/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked runtime target", () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-test-"));
    try {
      const file = join(directory, "runtime.json");
      const link = join(directory, "link.json");
      writeFileSync(file, "{}\n");
      symlinkSync(file, link);
      expect(() => prepareRuntimeTarget(link)).toThrow(/already exists/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not echo a rejected callback url to stderr", async () => {
    const secret = "super-secret-password";
    const { child, ready, stderr } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
      FEISHU_SIMULATOR_CALLBACK_URL: `http://user:${secret}@127.0.0.1:3000/api/integrations/feishu/events`,
    });
    ready.catch(() => undefined);
    const code = await waitForExit(child);
    expect(code).not.toBe(0);
    expect(stderr()).toContain("simulator_callback_url_invalid");
    expect(stderr()).not.toContain(secret);
  });

  it("does not echo a rejected port value to stderr", async () => {
    const secret = "super-secret-port";
    const { child, ready, stderr } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: secret,
    });
    ready.catch(() => undefined);
    const code = await waitForExit(child);
    expect(code).not.toBe(0);
    expect(stderr()).toContain("simulator_port_invalid");
    expect(stderr()).not.toContain(secret);
  });

  it("does not remove a replacement runtime file at shutdown", async () => {
    const { child, ready } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    const directory = resolve(line.runtimeFile, "..");
    try {
      rmSync(line.runtimeFile, { force: true });
      writeFileSync(line.runtimeFile, "{\"replacement\":true}\n");
      child.kill("SIGTERM");
      await waitForExit(child);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      expect(readFileSync(line.runtimeFile, "utf8")).toBe("{\"replacement\":true}\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the runtime file and its own directory on SIGINT", async () => {
    const { child, ready } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    const directory = resolve(line.runtimeFile, "..");
    expect(existsSync(line.runtimeFile)).toBe(true);
    child.kill("SIGINT");
    await waitForExit(child);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(existsSync(line.runtimeFile)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it("removes the runtime file and its own directory on shutdown", async () => {
    const { child, ready } = startCli({
      FEISHU_SIMULATOR_ENABLED: "1",
      NODE_ENV: "test",
      FEISHU_SIMULATOR_PORT: "0",
    });
    const line = await ready;
    const directory = resolve(line.runtimeFile, "..");
    expect(existsSync(line.runtimeFile)).toBe(true);
    child.kill("SIGTERM");
    await waitForExit(child);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(existsSync(line.runtimeFile)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it("keeps a caller-specified directory and removes only its own file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-test-"));
    const file = join(directory, "runtime.json");
    try {
      const { child, ready } = startCli({
        FEISHU_SIMULATOR_ENABLED: "1",
        NODE_ENV: "test",
        FEISHU_SIMULATOR_PORT: "0",
        FEISHU_SIMULATOR_RUNTIME_FILE: file,
      });
      const line = await ready;
      expect(line.runtimeFile).toBe(file);
      child.kill("SIGTERM");
      await waitForExit(child);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      expect(existsSync(file)).toBe(false);
      expect(existsSync(directory)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes the runtime file exclusively", () => {
    const directory = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-test-"));
    try {
      const target = prepareRuntimeTarget(join(directory, "runtime.json"));
      const runtime = {
        schemaVersion: MOCK_RUNTIME_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:19400",
        callbackUrl: "http://127.0.0.1:3000/api/integrations/feishu/events",
        appId: MOCK_APP_ID,
        tenantKey: MOCK_TENANT_KEY,
        ...createRunSecrets(),
      } as MockRuntime;
      writeRuntimeFile(target, runtime);
      expect(() => writeRuntimeFile(target, runtime)).toThrow(/already exists/);
      removeRuntimeTarget(target);
      expect(existsSync(target.file)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
