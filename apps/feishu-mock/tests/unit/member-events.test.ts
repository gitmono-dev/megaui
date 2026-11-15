import { createDecipheriv, createHash } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MOCK_EVENT_MAX_RECORDS } from "../../src/callbacks";
import { startMockListener, type MockListener } from "../../src/server";

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const VERIFICATION_TOKEN = "verification-token-of-this-run";
const ENCRYPT_KEY = "encrypt-key-of-this-run";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";

let listener: MockListener | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await listener?.close();
  listener = undefined;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    });
  }
});

async function startReceiver(statusCode = 200): Promise<{ url: string; events: Record<string, unknown>[] }> {
  const events: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const timestamp = String(req.headers["x-lark-request-timestamp"] ?? "");
      const nonce = String(req.headers["x-lark-request-nonce"] ?? "");
      const expected = createHash("sha256")
        .update(Buffer.from(`${timestamp}${nonce}${ENCRYPT_KEY}`, "utf8"))
        .update(body)
        .digest("hex");
      const wrapper = JSON.parse(body.toString("utf8")) as { encrypt: string };
      const raw = Buffer.from(wrapper.encrypt, "base64");
      const key = createHash("sha256").update(ENCRYPT_KEY, "utf8").digest();
      const decipher = createDecipheriv("aes-256-cbc", key, raw.subarray(0, 16));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
      if (expected !== req.headers["x-lark-signature"]) throw new Error("signature mismatch");
      events.push(JSON.parse(plaintext) as Record<string, unknown>);
      res.statusCode = statusCode;
      res.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/api/integrations/feishu/events`, events };
}

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, baseUrl);
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? "GET", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += String(chunk);
        });
        response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(callbackUrl: string): Promise<MockListener> {
  const config = resolveMockConfig({
    FEISHU_SIMULATOR_ENABLED: "1",
    NODE_ENV: "test",
    FEISHU_SIMULATOR_PORT: "0",
    FEISHU_SIMULATOR_CALLBACK_URL: callbackUrl,
  });
  listener = await startMockListener(config, {
    adminToken: ADMIN_TOKEN,
    appSecret: APP_SECRET,
    verificationToken: VERIFICATION_TOKEN,
    encryptKey: ENCRYPT_KEY,
  });
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
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { tenant_access_token: string }).tenant_access_token;
}

describe("member changes and contact events (FSM-13)", () => {
  it("makes a patched status readable and emits the frozen updated event", async () => {
    const { url, events } = await startReceiver();
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/users/ou_mock_bob", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { code: number; data: { eventId: string; delivered: boolean } };
    expect(payload.code).toBe(0);
    expect(payload.data.delivered).toBe(true);

    const token = await issueToken();
    const single = await call(
      listener!.baseUrl,
      "/open-apis/contact/v3/users/ou_mock_bob?user_id_type=open_id&department_id_type=open_department_id",
      { headers: { authorization: `Bearer ${token}` } },
    );
    const user = (JSON.parse(single.body) as { data: { user: Record<string, unknown> } }).data.user;
    expect(user.status).toEqual({
      is_activated: true,
      is_frozen: true,
      is_resigned: false,
      is_exited: false,
    });

    const event = events[0] as {
      header: { event_type: string; event_id: string };
      event: { object: Record<string, unknown>; old_object: Record<string, unknown> };
    };
    expect(event.header.event_type).toBe("contact.user.updated_v3");
    expect(event.header.event_id).toBe(payload.data.eventId);
    expect(event.event.object.open_id).toBe("ou_mock_bob");
    expect((event.event.object.status as Record<string, boolean>).is_frozen).toBe(true);
    expect(event.event.old_object).toEqual({
      open_id: "ou_mock_bob",
      status: { is_activated: true, is_frozen: false, is_resigned: false, is_exited: false },
    });
  });

  it("removes a deleted member and emits the frozen deleted snapshot", async () => {
    const { url, events } = await startReceiver();
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/users/ou_mock_carol", {
      method: "DELETE",
      headers: admin(),
    });
    expect(response.status).toBe(200);

    const token = await issueToken();
    const single = await call(
      listener!.baseUrl,
      "/open-apis/contact/v3/users/ou_mock_carol?user_id_type=open_id&department_id_type=open_department_id",
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(single.status).toBe(404);
    expect(JSON.parse(single.body)).toEqual({ code: 4, msg: "mock_user_not_found" });

    const directory = await call(
      listener!.baseUrl,
      "/open-apis/contact/v3/users/find_by_department?department_id=od_mock_operations&page_size=100",
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect((JSON.parse(directory.body) as { data: { items: unknown[] } }).data.items).toEqual([]);

    const event = events[0] as {
      header: { event_type: string };
      event: { object: Record<string, unknown>; old_object: Record<string, unknown> };
    };
    expect(event.header.event_type).toBe("contact.user.deleted_v3");
    expect(event.event.object).toMatchObject({
      open_id: "ou_mock_carol",
      department_ids: ["od_mock_operations"],
      status: { is_activated: false, is_frozen: false, is_resigned: true, is_exited: true },
    });
    expect(event.event.old_object).toEqual({
      open_id: "ou_mock_carol",
      department_ids: ["od_mock_operations"],
    });
  });

  it("keeps the directory fact when the callback fails", async () => {
    const { url } = await startReceiver(500);
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/users/ou_mock_alice", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "resigned" }),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { data: { delivered: boolean; statusCode: number } };
    expect(payload.data.delivered).toBe(false);
    expect(payload.data.statusCode).toBe(500);

    const token = await issueToken();
    const single = await call(
      listener!.baseUrl,
      "/open-apis/contact/v3/users/ou_mock_alice?user_id_type=open_id&department_id_type=open_department_id",
      { headers: { authorization: `Bearer ${token}` } },
    );
    const user = (JSON.parse(single.body) as { data: { user: Record<string, unknown> } }).data.user;
    expect((user.status as Record<string, boolean>).is_resigned).toBe(true);
  });

  it("keeps the messages and the uuid ownership of a deleted member", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const token = await issueToken();
    const sent = await call(listener!.baseUrl, "/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: "ou_mock_bob",
        msg_type: "text",
        content: JSON.stringify({ text: "before deletion" }),
        uuid: "uuid-keep",
      }),
    });
    expect(sent.status).toBe(200);
    const messageId = (JSON.parse(sent.body) as { data: { message_id: string } }).data.message_id;

    await call(listener!.baseUrl, "/__mock/users/ou_mock_bob", { method: "DELETE", headers: admin() });

    const state = await call(listener!.baseUrl, "/__mock/state", { headers: admin() });
    const inboxes = (JSON.parse(state.body) as { data: { inboxes: Record<string, unknown[]> } }).data.inboxes;
    expect(inboxes.ou_mock_bob).toHaveLength(1);

    const repeated = await call(listener!.baseUrl, "/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: "ou_mock_bob",
        msg_type: "text",
        content: JSON.stringify({ text: "before deletion" }),
        uuid: "uuid-keep",
      }),
    });
    expect(repeated.status).toBe(200);
    expect((JSON.parse(repeated.body) as { data: { message_id: string } }).data.message_id).toBe(messageId);
  });

  it("reserves the event capacity before the directory changes", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    for (let index = 0; index < MOCK_EVENT_MAX_RECORDS; index += 1) {
      listener!.state.events.push({ eventId: `evt_${index}`, eventType: "im.message.receive_v1", delivered: true });
    }
    const response = await call(listener!.baseUrl, "/__mock/users/ou_mock_carol", {
      method: "DELETE",
      headers: admin(),
    });
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body)).toEqual({ code: 6, msg: "mock_event_capacity_exceeded" });
    expect(listener!.state.users.map((user) => user.open_id)).toContain("ou_mock_carol");
    expect(listener!.state.events).toHaveLength(MOCK_EVENT_MAX_RECORDS);
  });

  it("refuses an unknown member and an invalid status", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const unknown = await call(listener!.baseUrl, "/__mock/users/ou_mock_unknown", {
      method: "DELETE",
      headers: admin(),
    });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ code: 4, msg: "mock_user_not_found" });

    const invalid = await call(listener!.baseUrl, "/__mock/users/ou_mock_alice", {
      method: "PATCH",
      headers: admin(),
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toEqual({ code: 1, msg: "mock_status_invalid" });
    expect(listener!.state.users.find((user) => user.open_id === "ou_mock_alice")?.status.is_activated).toBe(true);
  });
});
