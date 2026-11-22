import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MOCK_FAULT_TIMEOUT_DELAY_MS } from "../../src/faults";
import { startMockListener, type MockListener } from "../../src/server";

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";
const MESSAGE_PATH = "/open-apis/im/v1/messages?receive_id_type=open_id";

let listener: MockListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolvePromise) => {
    const target = new URL(path, baseUrl);
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += String(chunk);
        });
        response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) => resolvePromise({ error: error.code ?? "error" }));
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(): Promise<MockListener> {
  listener = await startMockListener(resolveMockConfig({
    FEISHU_SIMULATOR_ENABLED: "1",
    NODE_ENV: "test",
    FEISHU_SIMULATOR_PORT: "0",
  }), { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET, verificationToken: "vt", encryptKey: "ek" });
  return listener;
}

function admin(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function issueToken(): Promise<string> {
  const response = await call(listener!.baseUrl, "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: "cli_mock_megaui", app_secret: APP_SECRET }),
  });
  if ("error" in response) throw new Error(response.error);
  return (JSON.parse(response.body) as { tenant_access_token: string }).tenant_access_token;
}

async function addFault(rule: Record<string, unknown>): Promise<void> {
  const response = await call(listener!.baseUrl, "/__mock/faults", {
    method: "POST",
    headers: admin(),
    body: JSON.stringify(rule),
  });
  expect((response as { status: number }).status).toBe(200);
}

function message(uuid: string): string {
  return JSON.stringify({
    receive_id: "ou_mock_alice",
    msg_type: "text",
    content: JSON.stringify({ text: "hello" }),
    uuid,
  });
}

async function inboxSize(): Promise<number> {
  const state = await call(listener!.baseUrl, "/__mock/state", { method: "GET", headers: admin() });
  const view = JSON.parse((state as { body: string }).body) as { data: { inboxes: Record<string, unknown[]> } };
  return view.data.inboxes.ou_mock_alice?.length ?? 0;
}

describe("asynchronous fault admission and cancellation (FSM-19)", () => {
  it("accepts the asynchronous kinds for messages and refuses them elsewhere", async () => {
    await startListener();
    await addFault({ target: "message", kind: "timeout" });
    await addFault({ target: "message", kind: "disconnect_after_accept" });
    const refused = await call(listener!.baseUrl, "/__mock/faults", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ target: "directory", kind: "disconnect_after_accept" }),
    });
    expect((refused as { status: number }).status).toBe(400);
  });

  it("answers 504 after the frozen delay", async () => {
    await startListener();
    const token = await issueToken();
    await addFault({ target: "message", kind: "timeout" });
    const started = Date.now();
    const response = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: message("uuid-timeout"),
    });
    expect("status" in response && response.status).toBe(504);
    expect(JSON.parse((response as { body: string }).body)).toEqual({ code: 7, msg: "mock_provider_timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(MOCK_FAULT_TIMEOUT_DELAY_MS - 100);
  }, 15_000);

  it("disconnects only after the message was accepted", async () => {
    await startListener();
    const token = await issueToken();
    await addFault({ target: "message", kind: "disconnect_after_accept" });
    const response = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: message("uuid-accepted"),
    });
    expect("error" in response).toBe(true);
    expect(await inboxSize()).toBe(1);

    // The retry answers from the ledger, so no second message appears.
    await addFault({ target: "message", kind: "429" });
    const retry = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: message("uuid-accepted"),
    });
    expect("status" in retry && retry.status).toBe(200);
    expect(await inboxSize()).toBe(1);
  });

  it("cancels the delay when the run is reset", async () => {
    await startListener();
    const token = await issueToken();
    await addFault({ target: "message", kind: "timeout" });
    const pending = call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: message("uuid-reset"),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const started = Date.now();
    const reset = await call(listener!.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect((reset as { status: number }).status).toBe(200);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(MOCK_FAULT_TIMEOUT_DELAY_MS);
    expect("status" in result && result.status).toBe(504);
    // The cancelled delivery left nothing behind, and the state keeps no event ledger (FSL-140).
    expect(await inboxSize()).toBe(0);
    expect(listener!.state).not.toHaveProperty("events");
  }, 15_000);

  it("applies the timeout fault to every provider target", async () => {
    await startListener();
    const token = await issueToken();
    await addFault({ target: "directory", kind: "timeout" });
    const started = Date.now();
    const response = await call(
      listener!.baseUrl,
      "/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering",
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect("status" in response && response.status).toBe(504);
    expect(JSON.parse((response as { body: string }).body)).toEqual({ code: 7, msg: "mock_provider_timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(MOCK_FAULT_TIMEOUT_DELAY_MS - 100);
  }, 15_000);

  it("keeps the remaining rules in order after the asynchronous ones", async () => {
    await startListener();
    const token = await issueToken();
    await addFault({ target: "message", kind: "403", skip: 1, count: 1 });
    const skipped = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: message("uuid-order-1"),
    });
    expect("status" in skipped && skipped.status).toBe(200);
    const injected = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: message("uuid-order-2"),
    });
    expect("status" in injected && injected.status).toBe(403);
  });
});
