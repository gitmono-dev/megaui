// megaui-only (FS-09): Feishu callback verification and projection.
/**
 * Verifies the exact callback wire bytes before parsing, decrypts the optional
 * AES wrapper, validates the configured callback identity, and projects only
 * the fields accepted by FS-66. Raw bodies and private-message text never leave
 * this module.
 */
import {
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from "node:crypto";

import type { VerifiedEnterpriseEvent } from "@megaui/engine";

export const FEISHU_EVENT_TIMESTAMP_HEADER = "X-Lark-Request-Timestamp";
export const FEISHU_EVENT_NONCE_HEADER = "X-Lark-Request-Nonce";
export const FEISHU_EVENT_SIGNATURE_HEADER = "X-Lark-Signature";
export const FEISHU_EVENT_MAX_BODY_BYTES = 256 * 1024;
export const FEISHU_EVENT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

const MAX_CONFIG_VALUE_LENGTH = 4_096;
const MAX_HEADER_VALUE_LENGTH = 256;
const MAX_CALLBACK_FIELD_LENGTH = 4_096;
const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface FeishuEventConfig {
  tenantKey: string;
  appId: string;
  verificationToken: string;
  encryptKey: string;
}

export type FeishuCallbackErrorCode =
  | "callback_config_missing"
  | "callback_body_too_large"
  | "callback_headers_invalid"
  | "callback_signature_invalid"
  | "callback_timestamp_outside_window"
  | "callback_payload_invalid"
  | "callback_decryption_failed"
  | "callback_token_invalid"
  | "callback_tenant_invalid"
  | "callback_app_invalid";

/** Stable, sanitized errors suitable for the public callback response. */
export class FeishuCallbackError extends Error {
  readonly code: FeishuCallbackErrorCode;
  readonly status: number;

  constructor(code: FeishuCallbackErrorCode, status: number) {
    super(`[@megaui/web] ${code}`);
    this.name = "FeishuCallbackError";
    this.code = code;
    this.status = status;
  }
}

export type VerifiedFeishuCallback =
  | { kind: "url_verification"; challenge: string }
  | { kind: "event"; event: VerifiedEnterpriseEvent }
  | { kind: "ignored" };

export interface VerifyFeishuCallbackInput {
  headers: Headers;
  body: Uint8Array;
  config: FeishuEventConfig;
  now?: () => number;
  replayWindowMs?: number;
}

function callbackError(
  code: FeishuCallbackErrorCode,
  status: number,
): FeishuCallbackError {
  return new FeishuCallbackError(code, status);
}

function requireConfigValue(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = source[name]?.trim();
  if (!value || value.length > MAX_CONFIG_VALUE_LENGTH) {
    throw callbackError("callback_config_missing", 503);
  }
  return value;
}

/** Resolves callback configuration from an injected source without retaining it. */
export function resolveFeishuEventConfig(
  source: Readonly<Record<string, string | undefined>>,
): FeishuEventConfig {
  return {
    tenantKey: requireConfigValue(source, "FEISHU_TENANT_KEY"),
    appId: requireConfigValue(source, "FEISHU_APP_ID"),
    verificationToken: requireConfigValue(
      source,
      "FEISHU_EVENT_VERIFICATION_TOKEN",
    ),
    encryptKey: requireConfigValue(source, "FEISHU_EVENT_ENCRYPT_KEY"),
  };
}

/** Lazily reads process configuration when the callback route is invoked. */
export function getFeishuEventConfig(): FeishuEventConfig {
  return resolveFeishuEventConfig(process.env);
}

/** Reads a request body with a hard byte cap instead of unbounded arrayBuffer(). */
export async function readBoundedFeishuBody(
  request: Request,
  maxBytes = FEISHU_EVENT_MAX_BODY_BYTES,
): Promise<Buffer> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && DECIMAL_INTEGER.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw callbackError("callback_body_too_large", 413);
    }
  }

  if (request.body === null) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw callbackError("callback_body_too_large", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function requireSignatureHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (
    value === null ||
    value.length === 0 ||
    value.length > MAX_HEADER_VALUE_LENGTH
  ) {
    throw callbackError("callback_headers_invalid", 400);
  }
  return value;
}

function equalText(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function verifySignature(
  timestamp: string,
  nonce: string,
  signature: string,
  body: Uint8Array,
  encryptKey: string,
): void {
  if (!LOWERCASE_SHA256.test(signature)) {
    throw callbackError("callback_signature_invalid", 401);
  }
  const expected = createHash("sha256")
    .update(Buffer.from(`${timestamp}${nonce}${encryptKey}`, "utf8"))
    .update(body)
    .digest();
  const presented = Buffer.from(signature, "hex");
  if (!timingSafeEqual(expected, presented)) {
    throw callbackError("callback_signature_invalid", 401);
  }
}

function verifyReplayWindow(
  timestamp: string,
  now: number,
  replayWindowMs: number,
): void {
  if (!DECIMAL_INTEGER.test(timestamp)) {
    throw callbackError("callback_headers_invalid", 400);
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    throw callbackError("callback_headers_invalid", 400);
  }
  const callbackTime = seconds * 1_000;
  if (
    !Number.isSafeInteger(callbackTime) ||
    !Number.isFinite(now) ||
    Math.abs(now - callbackTime) > replayWindowMs
  ) {
    throw callbackError("callback_timestamp_outside_window", 401);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw callbackError("callback_payload_invalid", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeEncryptedPayload(value: string, encryptKey: string): unknown {
  try {
    if (
      value.length === 0 ||
      value.length % 4 !== 0 ||
      !BASE64.test(value)
    ) {
      throw new Error("invalid base64");
    }
    const packed = Buffer.from(value, "base64");
    if (
      packed.toString("base64") !== value ||
      packed.length <= 16 ||
      (packed.length - 16) % 16 !== 0
    ) {
      throw new Error("invalid ciphertext");
    }
    const key = createHash("sha256").update(encryptKey, "utf8").digest();
    const decipher = createDecipheriv(
      "aes-256-cbc",
      key,
      packed.subarray(0, 16),
    );
    const plaintext = Buffer.concat([
      decipher.update(packed.subarray(16)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw callbackError("callback_decryption_failed", 400);
  }
}

function unwrapPayload(wirePayload: unknown, encryptKey: string): unknown {
  if (!isRecord(wirePayload) || !("encrypt" in wirePayload)) {
    return wirePayload;
  }
  if (typeof wirePayload.encrypt !== "string") {
    throw callbackError("callback_decryption_failed", 400);
  }
  return decodeEncryptedPayload(wirePayload.encrypt, encryptKey);
}

function requireRecord(
  value: unknown,
  code: FeishuCallbackErrorCode = "callback_payload_invalid",
): Record<string, unknown> {
  if (!isRecord(value)) throw callbackError(code, 400);
  return value;
}

function requireText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/\S/u.test(value) ||
    value.length > MAX_CALLBACK_FIELD_LENGTH
  ) {
    throw callbackError("callback_payload_invalid", 400);
  }
  return value;
}

function requireMilliseconds(value: unknown): Date {
  const text = requireText(value);
  if (!DECIMAL_INTEGER.test(text)) {
    throw callbackError("callback_payload_invalid", 400);
  }
  const milliseconds = Number(text);
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.getTime())) {
    throw callbackError("callback_payload_invalid", 400);
  }
  return date;
}

function assertConfiguredValue(
  presented: unknown,
  expected: string,
  code:
    | "callback_token_invalid"
    | "callback_tenant_invalid"
    | "callback_app_invalid",
): void {
  if (typeof presented !== "string" || !equalText(presented, expected)) {
    throw callbackError(code, 401);
  }
}

function pairingTokenDigest(content: unknown): string | undefined {
  if (typeof content !== "string" || content.length > FEISHU_EVENT_MAX_BODY_BYTES) {
    throw callbackError("callback_payload_invalid", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw callbackError("callback_payload_invalid", 400);
  }
  const message = requireRecord(parsed);
  if (typeof message.text !== "string") {
    throw callbackError("callback_payload_invalid", 400);
  }
  const match = /^\/login[ \t]+([^\s]+)[ \t]*$/.exec(message.text);
  if (!match) return undefined;
  const token = match[1];
  if (!token || token.length > MAX_CALLBACK_FIELD_LENGTH) return undefined;
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function projectBusinessEvent(
  payload: Record<string, unknown>,
  config: FeishuEventConfig,
): VerifiedFeishuCallback {
  if (payload.schema !== "2.0") {
    throw callbackError("callback_payload_invalid", 400);
  }
  const header = requireRecord(payload.header);
  assertConfiguredValue(
    header.token,
    config.verificationToken,
    "callback_token_invalid",
  );
  assertConfiguredValue(
    header.tenant_key,
    config.tenantKey,
    "callback_tenant_invalid",
  );
  assertConfiguredValue(header.app_id, config.appId, "callback_app_invalid");

  const eventId = requireText(header.event_id);
  const eventType = requireText(header.event_type);
  const eventCreatedAt = requireMilliseconds(header.create_time);
  const event = requireRecord(payload.event);
  const base = {
    tenantKey: config.tenantKey,
    appId: config.appId,
    eventId,
    eventCreatedAt,
  };

  if (
    eventType === "contact.user.updated_v3" ||
    eventType === "contact.user.deleted_v3"
  ) {
    const object = requireRecord(event.object);
    return {
      kind: "event",
      event: {
        ...base,
        eventType,
        subjectOpenId: requireText(object.open_id),
      },
    };
  }

  if (eventType !== "im.message.receive_v1") {
    return { kind: "ignored" };
  }

  const sender = requireRecord(event.sender);
  const senderId = requireRecord(sender.sender_id);
  const message = requireRecord(event.message);
  const senderType = requireText(sender.sender_type);
  const chatType = requireText(message.chat_type);
  const messageType = requireText(message.message_type);
  requireMilliseconds(message.create_time);

  // Only a user-to-bot p2p text can participate in pairing. Other IM shapes are
  // acknowledged after verification but do not enter the durable inbox.
  if (
    senderType !== "user" ||
    chatType !== "p2p" ||
    messageType !== "text"
  ) {
    return { kind: "ignored" };
  }

  const digest = pairingTokenDigest(message.content);
  return {
    kind: "event",
    event: {
      ...base,
      eventType,
      messageId: requireText(message.message_id),
      senderOpenId: requireText(senderId.open_id),
      senderType,
      chatType,
      messageType,
      ...(digest === undefined ? {} : { pairingTokenDigest: digest }),
    },
  };
}

/** Verifies and projects one callback without performing persistence. */
export function verifyFeishuCallback(
  input: VerifyFeishuCallbackInput,
): VerifiedFeishuCallback {
  const timestamp = requireSignatureHeader(
    input.headers,
    FEISHU_EVENT_TIMESTAMP_HEADER,
  );
  const nonce = requireSignatureHeader(input.headers, FEISHU_EVENT_NONCE_HEADER);
  const signature = requireSignatureHeader(
    input.headers,
    FEISHU_EVENT_SIGNATURE_HEADER,
  );
  if (!DECIMAL_INTEGER.test(timestamp)) {
    throw callbackError("callback_headers_invalid", 400);
  }

  verifySignature(
    timestamp,
    nonce,
    signature,
    input.body,
    input.config.encryptKey,
  );
  verifyReplayWindow(
    timestamp,
    (input.now ?? Date.now)(),
    input.replayWindowMs ?? FEISHU_EVENT_REPLAY_WINDOW_MS,
  );

  const wirePayload = parseJson(input.body);
  const payload = requireRecord(
    unwrapPayload(wirePayload, input.config.encryptKey),
  );

  if (payload.type === "url_verification") {
    assertConfiguredValue(
      payload.token,
      input.config.verificationToken,
      "callback_token_invalid",
    );
    return {
      kind: "url_verification",
      challenge: requireText(payload.challenge),
    };
  }

  return projectBusinessEvent(payload, input.config);
}
