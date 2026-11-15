import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  FeishuMockStartError,
  startFeishuMock,
  type StartedFeishuMock,
} from "../e2e/helpers/feishu-mock";

const CALLBACK_PATH = "/api/integrations/feishu/events";
const started: StartedFeishuMock[] = [];
const callerServers: Server[] = [];

afterEach(async () => {
  for (const handle of started.splice(0)) await handle.stop();
  for (const server of callerServers.splice(0)) {
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    });
  }
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
    expect(handle.runtime.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/integrations\/feishu\/events$/);
  }, 30_000);

  it("creates a default callback receiver on a port the kernel assigned", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    expect(await listening(handle.runtime.callbackUrl)).toBe(true);
    await handle.stop();
    started.length = 0;
    expect(await listening(handle.runtime.callbackUrl)).toBe(false);
  }, 30_000);

  it("accepts a caller supplied callback url and never closes it", async () => {
    const receiver = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.statusCode = 200;
        response.end("{}");
      });
    });
    callerServers.push(receiver);
    await new Promise<void>((resolvePromise) => receiver.listen(0, "127.0.0.1", () => resolvePromise()));
    const address = receiver.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const url = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const handle = await startFeishuMock({ callbackUrl: url });
    started.push(handle);
    expect(handle.runtime.callbackUrl).toBe(url);
    await handle.stop();
    started.length = 0;
    expect(await listening(url)).toBe(true);
  }, 30_000);

  it("refuses an illegal callback target at the CLI validator", async () => {
    await expect(
      startFeishuMock({ callbackUrl: "http://127.0.0.1:3000/not-the-callback-path" }),
    ).rejects.toBeInstanceOf(FeishuMockStartError);
    const error = await startFeishuMock({ callbackUrl: "http://0.0.0.0:3000/api/integrations/feishu/events" }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(FeishuMockStartError);
    expect((error as FeishuMockStartError).code).toBe("mock_start_exited");
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
