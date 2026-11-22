import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { startFeishuMock, type StartedFeishuMock } from "../e2e/helpers/feishu-mock";

const started: StartedFeishuMock[] = [];

afterEach(async () => {
  for (const handle of started.splice(0)) await handle.stop();
});

async function listening(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.status > 0;
  } catch {
    return false;
  }
}

describe("reusable CLI fixture startup (FSM-15)", () => {
  it("starts the real CLI with the frozen protocol and port zero", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.baseUrl).not.toMatch(/:19400$/);
    expect(handle.runtime.schemaVersion).toBe(1);
    expect(handle.runtime.baseUrl).toBe(handle.baseUrl);
    expect(handle.runtime.appId).toBe("cli_mock_megaui");
    expect(handle.runtime.tenantKey).toBe("tenant_mock_megaui");
    // FSL-140: the mock sends no callbacks, so its runtime carries no callback url.
    expect(handle.runtime).not.toHaveProperty("callbackUrl");
    const runtime = JSON.parse(readFileSync(handle.runtimeFile, "utf8")) as Record<string, unknown>;
    expect(runtime).not.toHaveProperty("callbackUrl");
  }, 30_000);

  it("answers only when the ready line, the runtime file and health agree", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    const health = await fetch(`${handle.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "feishu-mock" });
  }, 30_000);

  it("finishes startup within the frozen budget and cleans up on stop", async () => {
    const before = Date.now();
    const handle = await startFeishuMock();
    started.push(handle);
    expect(Date.now() - before).toBeLessThan(15_000);
    expect(existsSync(handle.runtimeFile)).toBe(true);
    await handle.stop();
    started.length = 0;
    expect(existsSync(handle.runtimeFile)).toBe(false);
    expect(await listening(handle.baseUrl)).toBe(false);
  }, 30_000);
});
