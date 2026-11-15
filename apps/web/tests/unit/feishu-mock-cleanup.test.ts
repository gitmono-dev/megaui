import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { startFeishuMock, type StartedFeishuMock } from "../e2e/helpers/feishu-mock";

const started: StartedFeishuMock[] = [];

afterEach(async () => {
  // A teardown failure must fail the test, so the error is not swallowed.
  for (const handle of started.splice(0)) {
    await handle.stop();
  }
});

async function stateOf(handle: StartedFeishuMock): Promise<{ events: unknown[]; inboxes: Record<string, unknown[]> }> {
  const response = await fetch(`${handle.baseUrl}/__mock/state`, {
    headers: { authorization: `Bearer ${handle.runtime.adminToken}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { events: unknown[]; inboxes: Record<string, unknown[]> } };
  return body.data;
}

describe("per test reset and fixture cleanup (FSM-16)", () => {
  it("resets the run to its synthetic initial state", async () => {
    const handle = await startFeishuMock();
    started.push(handle);

    const sent = await fetch(`${handle.baseUrl}/__mock/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.runtime.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ openId: "ou_mock_alice", text: "hello" }),
    });
    expect(sent.status).toBe(200);
    expect((await stateOf(handle)).events).toHaveLength(1);

    await handle.reset();
    const afterReset = await stateOf(handle);
    expect(afterReset.events).toEqual([]);
    expect(afterReset.inboxes).toEqual({});
  }, 30_000);

  it("cancels the old callbacks before the receiver is cleared", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    const sent = await fetch(`${handle.baseUrl}/__mock/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.runtime.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ openId: "ou_mock_bob", text: "hello" }),
    });
    expect(sent.status).toBe(200);

    // The reset succeeds and the run is usable again afterwards.
    await handle.reset();
    expect((await stateOf(handle)).events).toEqual([]);
    const after = await fetch(`${handle.baseUrl}/__mock/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.runtime.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ openId: "ou_mock_alice", text: "again" }),
    });
    expect(after.status).toBe(200);
  }, 30_000);

  it("stops the process within the frozen grace and verifies the real exit", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    const startedAt = Date.now();
    await handle.stop();
    started.length = 0;
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(existsSync(handle.runtimeFile)).toBe(false);
    await expect(fetch(`${handle.baseUrl}/health`)).rejects.toBeTruthy();
  }, 30_000);

  it("only touches the resources the ready receipt confirmed for this run", async () => {
    const first = await startFeishuMock();
    const second = await startFeishuMock();
    started.push(first, second);
    expect(existsSync(first.runtimeFile)).toBe(true);
    expect(existsSync(second.runtimeFile)).toBe(true);

    await first.stop();
    started.length = 0;
    expect(existsSync(first.runtimeFile)).toBe(false);
    expect(existsSync(second.runtimeFile)).toBe(true);
    expect((await stateOf(second)).events).toEqual([]);
    await second.stop();
  }, 30_000);

  it("fails loudly when the teardown cannot complete", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    // The run is gone, so the reset of the teardown cannot succeed and the
    // failure must not be swallowed.
    expect(handle.pid).toBeTypeOf("number");
    process.kill(handle.pid as number, "SIGKILL");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    await expect(handle.stop()).rejects.toBeTruthy();
    started.length = 0;
  }, 30_000);
});
