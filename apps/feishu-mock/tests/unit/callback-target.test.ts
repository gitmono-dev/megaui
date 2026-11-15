import { createDecipheriv, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCallbackEnvelope,
  MOCK_CALLBACK_MAX_IN_FLIGHT,
  MOCK_CALLBACK_TIMEOUT_MS,
  MockCallbackSender,
  type MockCallbackApp,
} from "../../src/callbacks";
import { MockLifecycle } from "../../src/lifecycle";
import { createMockState, type MockState } from "../../src/state";

const APP: MockCallbackApp = {
  appId: "cli_mock_megaui",
  tenantKey: "tenant_mock_megaui",
  verificationToken: "verification-token-of-this-run",
  encryptKey: "encrypt-key-of-this-run",
};

const EVENT = {
  eventId: "evt_1",
  eventType: "im.message.receive_v1",
  createTime: 1_700_000_000_123,
  payload: { text: "hello" },
};

interface Received {
  headers: IncomingMessage["headers"];
  body: Buffer;
  plaintext: string;
  signatureOk: boolean;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    });
  }
});

/** A receiver that verifies the signature and decrypts independently. */
async function startReceiver(
  statusCode = 200,
): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const timestamp = String(request.headers["x-lark-request-timestamp"] ?? "");
      const nonce = String(request.headers["x-lark-request-nonce"] ?? "");
      const expected = createHash("sha256")
        .update(Buffer.from(`${timestamp}${nonce}${APP.encryptKey}`, "utf8"))
        .update(body)
        .digest("hex");
      const signatureOk = expected === request.headers["x-lark-signature"];
      const wrapper = JSON.parse(body.toString("utf8")) as { encrypt: string };
      const raw = Buffer.from(wrapper.encrypt, "base64");
      const key = createHash("sha256").update(APP.encryptKey, "utf8").digest();
      const decipher = createDecipheriv("aes-256-cbc", key, raw.subarray(0, 16));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
      received.push({ headers: request.headers, body, plaintext, signatureOk });
      response.statusCode = statusCode;
      response.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/api/integrations/feishu/events`, received };
}

/** A receiver that never answers, so the budget or the abort decides. */
async function startSlowReceiver(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request: IncomingMessage, _response: ServerResponse) => {
    // Intentionally never ends.
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/api/integrations/feishu/events` };
}

function senderFor(state: MockState, lifecycle: MockLifecycle, destination: string): MockCallbackSender {
  return new MockCallbackSender({ destination, app: APP, state, lifecycle });
}

describe("callback destination and delivery receipts (FSM-11)", () => {
  it("delivers to the frozen destination with a verifiable wire", async () => {
    const { url, received } = await startReceiver();
    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    const envelope = buildCallbackEnvelope(EVENT, APP);

    const result = await sender.send(envelope);
    expect(result.error).toBeUndefined();
    expect(result.delivery?.ok).toBe(true);
    expect(result.delivery?.statusCode).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]?.signatureOk).toBe(true);
    expect(JSON.parse(received[0]?.plaintext ?? "{}")).toEqual(envelope);
    expect(received[0]?.headers["content-type"]).toBe("application/json");

    const wire = received[0]?.body as Buffer;
    expect(wire.toString("utf8")).not.toContain("schema");
  });

  it("decides by the actual response status", async () => {
    const { url } = await startReceiver(500);
    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    const result = await sender.send(buildCallbackEnvelope(EVENT, APP));
    expect(result.delivery?.ok).toBe(false);
    expect(result.delivery?.statusCode).toBe(500);
    expect(state.events).toEqual([{ eventId: "evt_1", eventType: "im.message.receive_v1", delivered: false }]);
  });

  it("never follows a redirect", async () => {
    const target = await startReceiver();
    const redirectServer = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.statusCode = 302;
      response.setHeader("location", target.url);
      response.end();
    });
    servers.push(redirectServer);
    await new Promise<void>((resolvePromise) => redirectServer.listen(0, "127.0.0.1", () => resolvePromise()));
    const address = redirectServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, `http://127.0.0.1:${port}/api/integrations/feishu/events`);
    const result = await sender.send(buildCallbackEnvelope(EVENT, APP));
    expect(result.delivery?.ok).toBe(false);
    expect(result.delivery?.statusCode).toBe(302);
    expect(target.received).toHaveLength(0);
  });

  it("records only the frozen delivery summary", async () => {
    const { url } = await startReceiver();
    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    await sender.send(buildCallbackEnvelope(EVENT, APP));
    expect(state.events).toEqual([
      { eventId: "evt_1", eventType: "im.message.receive_v1", delivered: true },
    ]);
    const record = state.events[0] as unknown as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["delivered", "eventId", "eventType"]);
  });

  it("refuses a new event when the run already holds 100", async () => {
    const { url } = await startReceiver();
    const state = createMockState();
    for (let index = 0; index < 100; index += 1) {
      state.events.push({ eventId: `evt_${index}`, eventType: "im.message.receive_v1", delivered: true });
    }
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    const result = await sender.send(buildCallbackEnvelope(EVENT, APP));
    expect(result.error?.code).toBe(6);
    expect(result.error?.msg).toBe("mock_event_capacity_exceeded");
    expect(state.events).toHaveLength(100);
  });

  it("terminates a delivery within the frozen budget", async () => {
    const { url } = await startSlowReceiver();
    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    const started = Date.now();
    const result = await sender.send(buildCallbackEnvelope(EVENT, APP));
    expect(result.delivery?.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(MOCK_CALLBACK_TIMEOUT_MS + 1_500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(MOCK_CALLBACK_TIMEOUT_MS - 100);
    expect(MOCK_CALLBACK_TIMEOUT_MS).toBe(2_000);
  }, 15_000);

  it("refuses a new delivery when eight are in flight", async () => {
    const { url } = await startSlowReceiver();
    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < MOCK_CALLBACK_MAX_IN_FLIGHT; index += 1) {
      pending.push(sender.send(buildCallbackEnvelope({ ...EVENT, eventId: `evt_${index}` }, APP)));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(sender.inFlight).toBe(MOCK_CALLBACK_MAX_IN_FLIGHT);
    const refused = await sender.send(buildCallbackEnvelope(EVENT, APP));
    expect(refused.error?.code).toBe(6);
    expect(refused.error?.msg).toBe("mock_callback_capacity_exceeded");
    await lifecycle.reset();
    await Promise.all(pending);
  }, 15_000);

  it("aborts the in-flight delivery on a reset and refuses the write back", async () => {
    const { url } = await startSlowReceiver();
    const state = createMockState();
    const lifecycle = new MockLifecycle();
    const sender = senderFor(state, lifecycle, url);
    const pending = sender.send(buildCallbackEnvelope(EVENT, APP));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(sender.inFlight).toBe(1);

    await lifecycle.reset();
    const result = await pending;
    expect(result.delivery?.ok).toBe(false);
    // The reset cleared the run state and the stale completion cannot write back.
    expect(state.events).toEqual([]);
  }, 15_000);
});
