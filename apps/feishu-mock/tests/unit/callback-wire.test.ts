import { createDecipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildCallbackEnvelope,
  encodeCallback,
  MOCK_CALLBACK_CONTENT_TYPE,
  type MockCallbackApp,
  type MockCallbackEnvelope,
  type MockCallbackWire,
} from "../../src/callbacks";

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
  payload: { sender: { sender_id: { open_id: "ou_mock_alice" } } },
};

/**
 * The independent oracle.
 *
 * It does not import the codec: it recomputes the signature and decrypts the
 * payload with the frozen rules only, so a shared mistake cannot hide.
 */
function verify(wire: MockCallbackWire, app: MockCallbackApp): { signature: boolean; plaintext: string } {
  const timestamp = wire.headers["X-Lark-Request-Timestamp"];
  const nonce = wire.headers["X-Lark-Request-Nonce"];
  const expected = createHash("sha256")
    .update(Buffer.from(`${timestamp}${nonce}${app.encryptKey}`, "utf8"))
    .update(wire.body)
    .digest("hex");
  const signature = expected === wire.headers["X-Lark-Signature"];

  const wrapper = JSON.parse(wire.body.toString("utf8")) as { encrypt?: string };
  if (typeof wrapper.encrypt !== "string") {
    return { signature, plaintext: wire.body.toString("utf8") };
  }
  const raw = Buffer.from(wrapper.encrypt, "base64");
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const key = createHash("sha256").update(app.encryptKey, "utf8").digest();
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return { signature, plaintext };
}

describe("callback wire codec (FSM-03)", () => {
  it("encodes the frozen v2 envelope", () => {
    const envelope = buildCallbackEnvelope(EVENT, APP);
    expect(envelope.schema).toBe("2.0");
    expect(Object.keys(envelope).sort()).toEqual(["event", "header", "schema"]);
    expect(Object.keys(envelope.header).sort()).toEqual([
      "app_id",
      "create_time",
      "event_id",
      "event_type",
      "tenant_key",
      "token",
    ]);
    expect(envelope.header.event_id).toBe("evt_1");
    expect(envelope.header.event_type).toBe("im.message.receive_v1");
    expect(envelope.header.create_time).toBe("1700000000123");
    expect(envelope.header.token).toBe(APP.verificationToken);
    expect(envelope.header.app_id).toBe(APP.appId);
    expect(envelope.header.tenant_key).toBe(APP.tenantKey);
  });

  it("uses a unix second timestamp and a random nonce per send", () => {
    const envelope = buildCallbackEnvelope(EVENT, APP);
    const first = encodeCallback(envelope, APP, { encrypted: false, now: () => 1_700_000_000_999 });
    expect(first.headers["X-Lark-Request-Timestamp"]).toBe("1700000000");
    expect(first.headers["X-Lark-Request-Timestamp"]).toMatch(/^\d+$/);
    expect(first.headers["X-Lark-Request-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(first.headers["Content-Type"]).toBe(MOCK_CALLBACK_CONTENT_TYPE);

    const second = encodeCallback(envelope, APP, { encrypted: false, now: () => 1_700_000_000_999 });
    expect(second.headers["X-Lark-Request-Nonce"]).not.toBe(first.headers["X-Lark-Request-Nonce"]);
  });

  it("signs the actual wire bytes of the plaintext mode", () => {
    const envelope = buildCallbackEnvelope(EVENT, APP);
    const wire = encodeCallback(envelope, APP, { encrypted: false, nonce: () => "nonce-1" });
    const checked = verify(wire, APP);
    expect(checked.signature).toBe(true);
    expect(JSON.parse(checked.plaintext)).toEqual(envelope);
    expect(wire.body).toEqual(Buffer.from(JSON.stringify(envelope), "utf8"));
  });

  it("sends the raw JSON and not the encrypt wrapper in plaintext mode", () => {
    const envelope = buildCallbackEnvelope(EVENT, APP);
    const wire = encodeCallback(envelope, APP, { encrypted: false, nonce: () => "nonce-2" });
    const parsed = JSON.parse(wire.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed.schema).toBe("2.0");
    expect(parsed.encrypt).toBeUndefined();
  });

  it("encrypts with the sha256 key and a 16 byte iv", () => {
    const envelope = buildCallbackEnvelope(EVENT, APP);
    const wire = encodeCallback(envelope, APP, { encrypted: true, nonce: () => "nonce-3" });
    const wrapper = JSON.parse(wire.body.toString("utf8")) as { encrypt: string };
    expect(Object.keys(wrapper)).toEqual(["encrypt"]);
    const raw = Buffer.from(wrapper.encrypt, "base64");
    expect(raw.length).toBeGreaterThan(16);
    // AES-256-CBC with PKCS#7 makes the ciphertext a multiple of 16 bytes.
    expect((raw.length - 16) % 16).toBe(0);

    const checked = verify(wire, APP);
    expect(checked.signature).toBe(true);
    expect(JSON.parse(checked.plaintext)).toEqual(envelope);
  });

  it("signs the encrypt wrapper rather than the plaintext", () => {
    const envelope = buildCallbackEnvelope(EVENT, APP);
    const wire = encodeCallback(envelope, APP, { encrypted: true, nonce: () => "nonce-4" });
    const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
    // A signature over the plaintext would not match the wire bytes.
    const timestamp = wire.headers["X-Lark-Request-Timestamp"];
    const overPlaintext = createHash("sha256")
      .update(Buffer.from(`${timestamp}nonce-4${APP.encryptKey}`, "utf8"))
      .update(plaintext)
      .digest("hex");
    expect(overPlaintext).not.toBe(wire.headers["X-Lark-Signature"]);
    expect(verify(wire, APP).signature).toBe(true);
  });

  it("encodes two sends of one envelope to different wire bodies", () => {
    const envelope: MockCallbackEnvelope = buildCallbackEnvelope(EVENT, APP);
    const first = encodeCallback(envelope, APP, { encrypted: true });
    const second = encodeCallback(envelope, APP, { encrypted: true });
    expect(first.body.equals(second.body)).toBe(false);
    expect(verify(first, APP).signature).toBe(true);
    expect(verify(second, APP).signature).toBe(true);
  });
});
