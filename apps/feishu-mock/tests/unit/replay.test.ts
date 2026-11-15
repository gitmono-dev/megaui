import { createDecipheriv, createHash } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
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

interface Received {
  headers: IncomingMessage["headers"];
  plaintext: Record<string, unknown>;
}

async function startReceiver(statusCode = 200): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const wrapper = JSON.parse(body.toString("utf8")) as { encrypt: string };
      const raw = Buffer.from(wrapper.encrypt, "base64");
      const key = createHash("sha256").update(ENCRYPT_KEY, "utf8").digest();
      const decipher = createDecipheriv("aes-256-cbc", key, raw.subarray(0, 16));
      const plaintext = JSON.parse(
        Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8"),
      ) as Record<string, unknown>;
      received.push({ headers: req.headers, plaintext });
      res.statusCode = statusCode;
      res.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/api/integrations/feishu/events`, received };
}

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
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
    outgoing.on("error", (error: NodeJS.ErrnoException) =>
      resolvePromise({ status: -1, body: error.code ?? "error" }),
    );
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(callbackUrl: string): Promise<MockListener> {
  listener = await startMockListener(resolveMockConfig({
    FEISHU_SIMULATOR_ENABLED: "1",
    NODE_ENV: "test",
    FEISHU_SIMULATOR_PORT: "0",
    FEISHU_SIMULATOR_CALLBACK_URL: callbackUrl,
  }), {
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

async function sendMemberEvent(): Promise<{ eventId: string; received: Received[] }> {
  const response = await call(listener!.baseUrl, "/__mock/messages", {
    method: "POST",
    headers: admin(),
    body: JSON.stringify({ openId: "ou_mock_alice", text: "hello" }),
  });
  expect(response.status).toBe(200);
  return { eventId: (JSON.parse(response.body) as { data: { eventId: string } }).data.eventId, received: [] };
}

describe("bounded event replay (FSM-14)", () => {
  it("answers the frozen 404 for an event the run does not hold", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/replay", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ eventId: "evt_unknown" }),
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: 4, msg: "mock_event_not_found" });
  });

  it("keeps the identity and payload and regenerates the signature time and nonce", async () => {
    const { url, received } = await startReceiver();
    await startListener(url);
    const sent = await sendMemberEvent();
    const original = received[0]?.plaintext as {
      header: Record<string, unknown>;
      event: Record<string, unknown>;
    };

    const replay = await call(listener!.baseUrl, "/__mock/replay", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ eventId: sent.eventId }),
    });
    expect(replay.status).toBe(200);
    const payload = JSON.parse(replay.body) as { data: { eventId: string; delivered: boolean } };
    expect(payload.data.eventId).toBe(sent.eventId);
    expect(payload.data.delivered).toBe(true);

    const replayed = received[1]?.plaintext as {
      header: Record<string, unknown>;
      event: Record<string, unknown>;
    };
    expect(replayed.header.event_id).toBe(original.header.event_id);
    expect(replayed.header.event_type).toBe(original.header.event_type);
    expect(replayed.event).toEqual(original.event);
    expect(received[1]?.headers["x-lark-request-nonce"]).not.toBe(received[0]?.headers["x-lark-request-nonce"]);
  });

  it("does not take a new event identity", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const sent = await sendMemberEvent();
    const before = await call(listener!.baseUrl, "/__mock/state", { method: "GET", headers: admin() });
    const eventsBefore = (JSON.parse(before.body) as { data: { events: unknown[] } }).data.events;
    expect(eventsBefore).toHaveLength(1);

    await call(listener!.baseUrl, "/__mock/replay", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ eventId: sent.eventId }),
    });
    const after = await call(listener!.baseUrl, "/__mock/state", { method: "GET", headers: admin() });
    expect((JSON.parse(after.body) as { data: { events: unknown[] } }).data.events).toHaveLength(1);
  });

  it("does not consume the event capacity", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const sent = await sendMemberEvent();
    for (let index = 1; index < 100; index += 1) {
      listener!.state.events.push({ eventId: `evt_${index}`, eventType: "im.message.receive_v1", delivered: true });
    }
    const replay = await call(listener!.baseUrl, "/__mock/replay", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ eventId: sent.eventId }),
    });
    expect(replay.status).toBe(200);
    expect(listener!.state.events).toHaveLength(100);
  });

  it("reports the delivery as it actually happened", async () => {
    const { url } = await startReceiver(500);
    await startListener(url);
    const sent = await sendMemberEvent();
    const replay = await call(listener!.baseUrl, "/__mock/replay", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ eventId: sent.eventId }),
    });
    expect(replay.status).toBe(200);
    const payload = JSON.parse(replay.body) as { data: { delivered: boolean; statusCode: number } };
    expect(payload.data.delivered).toBe(false);
    expect(payload.data.statusCode).toBe(500);
  });

  it("refuses a replay after the run was reset", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const sent = await sendMemberEvent();
    const reset = await call(listener!.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(reset.status).toBe(200);
    const replay = await call(listener!.baseUrl, "/__mock/replay", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ eventId: sent.eventId }),
    });
    expect(replay.status).toBe(404);
  });
});
