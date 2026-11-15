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
  body: Buffer;
  plaintext: Record<string, unknown>;
  signatureOk: boolean;
  encrypted: boolean;
}

/** A receiver that verifies the signature and decrypts independently. */
async function startReceiver(
  answer: (plaintext: Record<string, unknown>) => string = (plaintext) =>
    JSON.stringify({ challenge: (plaintext as { challenge?: unknown }).challenge }),
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const timestamp = String(request.headers["x-lark-request-timestamp"] ?? "");
      const nonce = String(request.headers["x-lark-request-nonce"] ?? "");
      const expected = createHash("sha256")
        .update(Buffer.from(`${timestamp}${nonce}${ENCRYPT_KEY}`, "utf8"))
        .update(body)
        .digest("hex");
      const parsed = JSON.parse(body.toString("utf8")) as { encrypt?: string };
      let plaintext: Record<string, unknown>;
      const encrypted = typeof parsed.encrypt === "string";
      if (encrypted) {
        const raw = Buffer.from(parsed.encrypt as string, "base64");
        const key = createHash("sha256").update(ENCRYPT_KEY, "utf8").digest();
        const decipher = createDecipheriv("aes-256-cbc", key, raw.subarray(0, 16));
        plaintext = JSON.parse(
          Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8"),
        ) as Record<string, unknown>;
      } else {
        plaintext = parsed as Record<string, unknown>;
      }
      received.push({ body, plaintext, signatureOk: expected === request.headers["x-lark-signature"], encrypted });
      response.statusCode = 200;
      response.end(answer(plaintext));
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
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, baseUrl);
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
      (response: IncomingMessage) => {
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

describe("p2p message events and the URL handshake (FSM-12)", () => {
  it("sends the frozen p2p event for a current synthetic member", async () => {
    const { url, received } = await startReceiver();
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/messages", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ openId: "ou_mock_alice", text: "hello" }),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      code: number;
      data: { eventId: string; delivered: boolean; statusCode: number };
    };
    expect(payload.code).toBe(0);
    expect(payload.data.delivered).toBe(true);
    expect(payload.data.statusCode).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]?.signatureOk).toBe(true);
    expect(received[0]?.encrypted).toBe(true);
    const envelope = received[0]?.plaintext as {
      schema: string;
      header: Record<string, unknown>;
      event: Record<string, unknown>;
    };
    expect(envelope.schema).toBe("2.0");
    expect(envelope.header.event_id).toBe(payload.data.eventId);
    expect(envelope.header.event_type).toBe("im.message.receive_v1");
    expect(envelope.header.token).toBe(VERIFICATION_TOKEN);
    const event = envelope.event as {
      sender: { sender_id: { open_id: string }; sender_type: string };
      tenant_key: string;
      message: Record<string, unknown>;
    };
    expect(event.sender).toEqual({ sender_id: { open_id: "ou_mock_alice" }, sender_type: "user" });
    expect(event.tenant_key).toBe("tenant_mock_megaui");
    expect(event.message.chat_type).toBe("p2p");
    expect(event.message.message_type).toBe("text");
    expect(JSON.parse(String(event.message.content))).toEqual({ text: "hello" });
  });

  it("refuses a member that the synthetic directory does not hold", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/messages", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ openId: "ou_mock_unknown", text: "hello" }),
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: 4, msg: "mock_user_not_found" });
  });

  it("reuses the frozen text limit of the message input", async () => {
    const { url } = await startReceiver();
    await startListener(url);
    const accepted = await call(listener!.baseUrl, "/__mock/messages", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ openId: "ou_mock_alice", text: "x".repeat(4096) }),
    });
    expect(accepted.status).toBe(200);

    const refused = await call(listener!.baseUrl, "/__mock/messages", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ openId: "ou_mock_alice", text: "x".repeat(4097) }),
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ code: 1, msg: "mock_text_too_long" });
  });

  it("passes the URL handshake only when the same challenge comes back", async () => {
    const { url, received } = await startReceiver();
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/verify-callback", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ code: 0, data: { verified: true } });
    const sent = received[0]?.plaintext as { type: string; token: string; challenge: string };
    expect(sent.type).toBe("url_verification");
    expect(sent.token).toBe(VERIFICATION_TOKEN);
    expect(sent.challenge).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses the handshake when another challenge comes back", async () => {
    const { url } = await startReceiver(() => JSON.stringify({ challenge: "not-the-challenge" }));
    await startListener(url);
    const response = await call(listener!.baseUrl, "/__mock/verify-callback", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ code: 8, msg: "mock_callback_verification_failed" });
  });

  it("uses the explicit plaintext path when the control request asks for it", async () => {
    const { url, received } = await startReceiver();
    await startListener(url);
    const message = await call(listener!.baseUrl, "/__mock/messages", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ openId: "ou_mock_bob", text: "plain", encrypted: false }),
    });
    expect(message.status).toBe(200);
    expect(received[0]?.encrypted).toBe(false);
    expect(received[0]?.plaintext.schema).toBe("2.0");

    const verify = await call(listener!.baseUrl, "/__mock/verify-callback", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ encrypted: false }),
    });
    expect(verify.status).toBe(200);
    expect(received[1]?.encrypted).toBe(false);
    expect(received[1]?.plaintext.type).toBe("url_verification");
  });

  it("uses the encrypted mode by default", async () => {
    const { url, received } = await startReceiver();
    await startListener(url);
    await call(listener!.baseUrl, "/__mock/verify-callback", {
      method: "POST",
      headers: admin(),
      body: "{}",
    });
    expect(received[0]?.encrypted).toBe(true);
    expect(JSON.parse(received[0]?.body.toString("utf8") ?? "{}")).toHaveProperty("encrypt");
  });
});
