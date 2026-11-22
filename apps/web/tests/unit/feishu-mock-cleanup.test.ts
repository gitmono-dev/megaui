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

interface MockStateView {
  users: { open_id: string; status: Record<string, boolean> }[];
  inboxes: Record<string, unknown[]>;
  faults: unknown[];
}

async function stateOf(handle: StartedFeishuMock): Promise<MockStateView> {
  const response = await fetch(`${handle.baseUrl}/__mock/state`, {
    headers: { authorization: `Bearer ${handle.runtime.adminToken}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: MockStateView };
  return body.data;
}

function admin(handle: StartedFeishuMock): Record<string, string> {
  return { authorization: `Bearer ${handle.runtime.adminToken}`, "content-type": "application/json" };
}

/** Sends one directed message through the provider route, as the login code delivery does. */
async function sendMessage(handle: StartedFeishuMock, openId: string, text: string, uuid: string): Promise<Response> {
  const tokenResponse = await fetch(`${handle.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: handle.runtime.appId, app_secret: handle.runtime.appSecret }),
  });
  expect(tokenResponse.status).toBe(200);
  const token = ((await tokenResponse.json()) as { tenant_access_token: string }).tenant_access_token;
  return fetch(`${handle.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }), uuid }),
  });
}

describe("per test reset and fixture cleanup (FSM-16)", () => {
  it("resets the run to its synthetic initial state", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    const initial = await stateOf(handle);
    // FSL-140: the state keeps no event ledger.
    expect(Object.keys(initial).sort()).toEqual(["faults", "inboxes", "users"]);

    const sent = await sendMessage(handle, "ou_mock_alice", "hello", "uuid-reset");
    expect(sent.status).toBe(200);
    const patched = await fetch(`${handle.baseUrl}/__mock/users/ou_mock_bob`, {
      method: "PATCH",
      headers: admin(handle),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(patched.status).toBe(200);
    const fault = await fetch(`${handle.baseUrl}/__mock/faults`, {
      method: "POST",
      headers: admin(handle),
      body: JSON.stringify({ target: "token", kind: "500", count: 1 }),
    });
    expect(fault.status).toBe(200);
    const dirty = await stateOf(handle);
    expect(dirty.inboxes.ou_mock_alice).toHaveLength(1);
    expect(dirty.faults).toHaveLength(1);
    expect(dirty.users).not.toEqual(initial.users);

    await handle.reset();
    expect(await stateOf(handle)).toEqual(initial);
  }, 30_000);

  it("cancels the in-flight work of the old generation and keeps the run usable", async () => {
    const handle = await startFeishuMock();
    started.push(handle);
    const fault = await fetch(`${handle.baseUrl}/__mock/faults`, {
      method: "POST",
      headers: admin(handle),
      body: JSON.stringify({ target: "message", kind: "timeout", count: 1 }),
    });
    expect(fault.status).toBe(200);
    const pending = sendMessage(handle, "ou_mock_bob", "hello", "uuid-pending");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    // The reset succeeds, the delayed delivery ends without a message, and the run is usable again.
    await handle.reset();
    const cancelled = await pending;
    expect(cancelled.status).toBe(504);
    await cancelled.arrayBuffer();
    expect((await stateOf(handle)).inboxes).toEqual({});
    const after = await sendMessage(handle, "ou_mock_alice", "again", "uuid-after");
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
    expect((await stateOf(second)).inboxes).toEqual({});
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
