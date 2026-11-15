// FS-09: pure callback signature, decryption, replay, and projection tests.
import { createCipheriv, createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FEISHU_EVENT_NONCE_HEADER,
  FEISHU_EVENT_SIGNATURE_HEADER,
  FEISHU_EVENT_TIMESTAMP_HEADER,
  FeishuCallbackError,
  readBoundedFeishuBody,
  resolveFeishuEventConfig,
  verifyFeishuCallback,
  type FeishuEventConfig,
} from "../../lib/feishu-events";

const NOW = 1_800_000_000_000;
const CONFIG: FeishuEventConfig = {
  tenantKey: "tenant-test",
  appId: "cli_test",
  verificationToken: "verification-test",
  encryptKey: "encrypt-test",
};
const TIMESTAMP = String(NOW / 1_000);

function contactEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "evt-contact",
      event_type: "contact.user.updated_v3",
      create_time: String(NOW - 1_000),
      token: CONFIG.verificationToken,
      app_id: CONFIG.appId,
      tenant_key: CONFIG.tenantKey,
      ...overrides,
    },
    event: { object: { open_id: "ou-contact" } },
  };
}

function messageEnvelope(
  text: string,
  messageOverrides: Record<string, unknown> = {},
  senderOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "evt-message",
      event_type: "im.message.receive_v1",
      create_time: String(NOW - 1_000),
      token: CONFIG.verificationToken,
      app_id: CONFIG.appId,
      tenant_key: CONFIG.tenantKey,
    },
    event: {
      sender: {
        sender_id: { open_id: "ou-sender" },
        sender_type: "user",
        ...senderOverrides,
      },
      message: {
        message_id: "om-message",
        create_time: String(NOW - 1_000),
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
        ...messageOverrides,
      },
    },
  };
}

function encrypt(payload: unknown): Buffer {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const key = createHash("sha256").update(CONFIG.encryptKey, "utf8").digest();
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(
    JSON.stringify({
      encrypt: Buffer.concat([iv, ciphertext]).toString("base64"),
    }),
    "utf8",
  );
}

function signedWire(
  payload: unknown,
  options: {
    encrypted?: boolean;
    timestamp?: string;
    nonce?: string;
    body?: Buffer;
  } = {},
): { body: Buffer; headers: Headers } {
  const timestamp = options.timestamp ?? TIMESTAMP;
  const nonce = options.nonce ?? "nonce-test";
  const body =
    options.body ??
    (options.encrypted
      ? encrypt(payload)
      : Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = createHash("sha256")
    .update(`${timestamp}${nonce}${CONFIG.encryptKey}`, "utf8")
    .update(body)
    .digest("hex");
  return {
    body,
    headers: new Headers({
      "Content-Type": "application/json",
      [FEISHU_EVENT_TIMESTAMP_HEADER]: timestamp,
      [FEISHU_EVENT_NONCE_HEADER]: nonce,
      [FEISHU_EVENT_SIGNATURE_HEADER]: signature,
    }),
  };
}

function verify(
  wire: { body: Buffer; headers: Headers },
  config = CONFIG,
) {
  return verifyFeishuCallback({
    ...wire,
    config,
    now: () => NOW,
  });
}

function expectCallbackError(
  action: () => unknown,
  code: FeishuCallbackError["code"],
): void {
  try {
    action();
    throw new Error("expected callback verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FeishuCallbackError);
    expect((error as FeishuCallbackError).code).toBe(code);
  }
}

describe("Feishu callback verification (FS-09)", () => {
  it("resolves all four values from injected configuration only", () => {
    expect(
      resolveFeishuEventConfig({
        FEISHU_TENANT_KEY: CONFIG.tenantKey,
        FEISHU_APP_ID: CONFIG.appId,
        FEISHU_EVENT_VERIFICATION_TOKEN: CONFIG.verificationToken,
        FEISHU_EVENT_ENCRYPT_KEY: CONFIG.encryptKey,
      }),
    ).toEqual(CONFIG);
    expectCallbackError(
      () => resolveFeishuEventConfig({}),
      "callback_config_missing",
    );
  });

  it("checks the signature against the exact raw body bytes before parsing", () => {
    const body = Buffer.from(
      JSON.stringify(contactEnvelope(), null, 2),
      "utf8",
    );
    const wire = signedWire(contactEnvelope(), { body });
    expect(verify(wire)).toMatchObject({
      kind: "event",
      event: {
        eventType: "contact.user.updated_v3",
        subjectOpenId: "ou-contact",
      },
    });

    const changed = Buffer.from(body);
    changed[changed.length - 2] = 32;
    expectCallbackError(
      () => verify({ headers: wire.headers, body: changed }),
      "callback_signature_invalid",
    );
  });

  it("decrypts the AES-256-CBC wrapper and projects Contact metadata", () => {
    const result = verify(signedWire(contactEnvelope(), { encrypted: true }));
    expect(result).toEqual({
      kind: "event",
      event: {
        tenantKey: CONFIG.tenantKey,
        appId: CONFIG.appId,
        eventId: "evt-contact",
        eventType: "contact.user.updated_v3",
        eventCreatedAt: new Date(NOW - 1_000),
        subjectOpenId: "ou-contact",
      },
    });
  });

  it("returns only an approved URL-verification challenge", () => {
    const payload = {
      type: "url_verification",
      token: CONFIG.verificationToken,
      challenge: "challenge-test",
    };
    expect(verify(signedWire(payload, { encrypted: true }))).toEqual({
      kind: "url_verification",
      challenge: "challenge-test",
    });

    expectCallbackError(
      () =>
        verify(
          signedWire({
            ...payload,
            token: "wrong-token",
          }),
        ),
      "callback_token_invalid",
    );
  });

  it("projects a user p2p text message with only the pairing-token digest", () => {
    const token = "opaque-pairing-token";
    const result = verify(
      signedWire(messageEnvelope(`/login ${token}`), { encrypted: true }),
    );
    expect(result).toMatchObject({
      kind: "event",
      event: {
        eventType: "im.message.receive_v1",
        messageId: "om-message",
        senderOpenId: "ou-sender",
        senderType: "user",
        chatType: "p2p",
        messageType: "text",
        pairingTokenDigest: createHash("sha256")
          .update(token, "utf8")
          .digest("hex"),
      },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("/login");
  });

  it("keeps unrelated text out of the projection and ignores non-pairing IM shapes", () => {
    const unrelated = verify(signedWire(messageEnvelope("hello")));
    expect(unrelated.kind).toBe("event");
    expect(JSON.stringify(unrelated)).not.toContain("hello");
    expect(unrelated).not.toHaveProperty("event.pairingTokenDigest");

    const groupMessage = messageEnvelope("/login token", {
      chat_type: "group",
    });
    const botMessage = messageEnvelope(
      "/login token",
      {},
      { sender_type: "bot" },
    );
    const imageMessage = messageEnvelope("/login token", {
      message_type: "image",
    });
    for (const payload of [groupMessage, botMessage, imageMessage]) {
      expect(verify(signedWire(payload))).toEqual({ kind: "ignored" });
    }
  });

  it("rejects invalid ciphertext after authenticating its wrapper", () => {
    const body = Buffer.from(
      JSON.stringify({ encrypt: Buffer.alloc(32).toString("base64") }),
      "utf8",
    );
    expectCallbackError(
      () => verify(signedWire({}, { body })),
      "callback_decryption_failed",
    );
  });

  it("rejects stale, tenant-mismatched, and app-mismatched envelopes", () => {
    expectCallbackError(
      () =>
        verify(
          signedWire(contactEnvelope(), {
            timestamp: String(NOW / 1_000 - 301),
          }),
        ),
      "callback_timestamp_outside_window",
    );
    expectCallbackError(
      () => verify(signedWire(contactEnvelope({ tenant_key: "other" }))),
      "callback_tenant_invalid",
    );
    expectCallbackError(
      () => verify(signedWire(contactEnvelope({ app_id: "other" }))),
      "callback_app_invalid",
    );
  });

  it("bounds raw-body reads before allocating an unbounded buffer", async () => {
    const request = new Request("http://127.0.0.1/callback", {
      method: "POST",
      body: "123456",
    });
    await expect(readBoundedFeishuBody(request, 5)).rejects.toMatchObject({
      code: "callback_body_too_large",
      status: 413,
    });
  });
});
