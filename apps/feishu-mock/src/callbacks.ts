/**
 * FSM-03：callback 的签名与加密 wire codec。
 *
 * 本片只做同步的纯编码：把业务信封按冻结 v2 schema 编码，生成签名 headers，
 * 按 SHA256 key + IV16 + AES-256-CBC 封装；明文模式直接发送原始 JSON。它不发
 * 网络请求、不持有在途任务，网络发送由 FSM-11 首次交付。
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

import { mockError, type MockHttpError } from "./http";
import type { MockLifecycle } from "./lifecycle";
import type { MockState } from "./state";

/** The frozen wire content type. */
export const MOCK_CALLBACK_CONTENT_TYPE = "application/json";

/** The frozen signature header names. */
export const MOCK_CALLBACK_TIMESTAMP_HEADER = "X-Lark-Request-Timestamp";
export const MOCK_CALLBACK_NONCE_HEADER = "X-Lark-Request-Nonce";
export const MOCK_CALLBACK_SIGNATURE_HEADER = "X-Lark-Signature";

/** The v2 business envelope. */
export interface MockCallbackEnvelope {
  schema: "2.0";
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: Record<string, unknown>;
}

export interface MockCallbackApp {
  appId: string;
  tenantKey: string;
  /** This run's verification token, written into every envelope header. */
  verificationToken: string;
  /** This run's encrypt key; also the material the signature is built from. */
  encryptKey: string;
}

export interface MockCallbackWire {
  headers: {
    "Content-Type": typeof MOCK_CALLBACK_CONTENT_TYPE;
    "X-Lark-Request-Timestamp": string;
    "X-Lark-Request-Nonce": string;
    "X-Lark-Signature": string;
  };
  /** The exact bytes that go on the wire. */
  body: Buffer;
}

export interface MockCallbackEncodeOptions {
  /** Send the encrypt wrapper when true, the raw JSON when false. */
  encrypted: boolean;
  /** The clock; the timestamp header is derived from it. */
  now?: () => number;
  /** The nonce source; a random 16 byte hex value by default. */
  nonce?: () => string;
}

/**
 * Encodes an envelope into the signed wire form.
 *
 * The signature covers the bytes that actually go on the wire, so it is
 * computed over the encrypt wrapper when the payload is encrypted and over
 * the raw JSON when it is not.
 */
export function encodeCallback(
  envelope: MockCallbackEnvelope,
  app: MockCallbackApp,
  options: MockCallbackEncodeOptions,
): MockCallbackWire {
  return encodeRawCallback(envelope, app, options);
}

/** Encodes any callback payload, not only the v2 envelope. */
export function encodeRawCallback(
  payload: unknown,
  app: MockCallbackApp,
  options: MockCallbackEncodeOptions,
): MockCallbackWire {
  const timestamp = String(Math.floor((options.now ?? Date.now)() / 1000));
  const nonce = (options.nonce ?? defaultNonce)();
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const body = options.encrypted ? encryptBody(plaintext, app.encryptKey) : plaintext;
  const signature = sign(timestamp, nonce, app.encryptKey, body);
  return {
    headers: {
      "Content-Type": MOCK_CALLBACK_CONTENT_TYPE,
      "X-Lark-Request-Timestamp": timestamp,
      "X-Lark-Request-Nonce": nonce,
      "X-Lark-Signature": signature,
    },
    body,
  };
}

/** True when the payload is the frozen v2 business envelope. */
export function isCallbackEnvelope(payload: unknown): payload is MockCallbackEnvelope {
  if (typeof payload !== "object" || payload === null) return false;
  const maybe = payload as { schema?: unknown; header?: { event_id?: unknown } };
  return maybe.schema === "2.0" && typeof maybe.header?.event_id === "string";
}

/** Builds the v2 envelope of one event. */
export function buildCallbackEnvelope(
  event: { eventId: string; eventType: string; createTime: number; payload: Record<string, unknown> },
  app: MockCallbackApp,
): MockCallbackEnvelope {
  return {
    schema: "2.0",
    header: {
      event_id: event.eventId,
      event_type: event.eventType,
      create_time: String(event.createTime),
      token: app.verificationToken,
      app_id: app.appId,
      tenant_key: app.tenantKey,
    },
    event: event.payload,
  };
}

/**
 * The signature: SHA256 over the UTF-8 timestamp and nonce and the encrypt
 * key, followed by the raw wire bytes, as lowercase hex.
 */
function sign(timestamp: string, nonce: string, encryptKey: string, body: Buffer): string {
  const prefix = Buffer.from(`${timestamp}${nonce}${encryptKey}`, "utf8");
  return createHash("sha256").update(prefix).update(body).digest("hex");
}

/**
 * Encrypts the payload: the key is the SHA256 of the encrypt key, the IV is
 * random 16 bytes, and the wire body is `{"encrypt":"<base64(iv||ciphertext)>"}`.
 */
function encryptBody(plaintext: Buffer, encryptKey: string): Buffer {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({ encrypt: Buffer.concat([iv, ciphertext]).toString("base64") }), "utf8");
}

function defaultNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The frozen delivery budget of one callback, in milliseconds. */
export const MOCK_CALLBACK_TIMEOUT_MS = 2_000;

/** How many callbacks may be in flight at the same time. */
export const MOCK_CALLBACK_MAX_IN_FLIGHT = 8;

/** How many event records one run keeps. */
export const MOCK_EVENT_MAX_RECORDS = 100;

/** The frozen delivery summary written into the run state. */
export interface MockCallbackSummary {
  ok: boolean;
  statusCode: number | null;
}

export type MockCallbackDelivery =
  | { ok: true; statusCode: number; summary: MockCallbackSummary; body?: string }
  | { ok: false; statusCode: number | null; summary: MockCallbackSummary; body?: string };

export interface MockCallbackSendOptions {
  /** Send the encrypt wrapper; the frozen default is encrypted. */
  encrypted?: boolean;
  /** Keep the response body, used by the URL verification handshake. */
  readBody?: boolean;
  /** Record the delivery in the run state; a replay does not. */
  record?: boolean;
}

export interface MockCallbackSendResult {
  delivery: MockCallbackDelivery | undefined;
  /** Set when the delivery was refused before it started. */
  error?: MockHttpError;
}

export interface MockCallbackSenderOptions {
  /** The frozen callback origin and path; a caller can never replace it. */
  destination: string;
  app: MockCallbackApp;
  state: MockState;
  lifecycle: MockLifecycle;
  now?: () => number;
}

/**
 * Delivers callbacks to the frozen destination.
 *
 * Only the configured origin and path are used, redirects are never followed,
 * and the outcome is decided by the actual response status. A delivery is
 * bounded by the frozen budget, the in-flight and event capacities are
 * enforced, and every delivery is registered as a task so a reset aborts it.
 */
export class MockCallbackSender {
  readonly #options: MockCallbackSenderOptions;
  #inFlight = 0;
  /** The envelopes this run delivered, so a replay keeps their identity. */
  readonly #archive = new Map<string, MockCallbackEnvelope>();

  constructor(options: MockCallbackSenderOptions) {
    this.#options = options;
  }

  /** How many deliveries are in flight. */
  get inFlight(): number {
    return this.#inFlight;
  }

    /**
   * Replays an event this run delivered.
   *
   * The identity and the business payload are kept, while the timestamp and
   * nonce are generated again, and the replay never takes a new event
   * identity. Only an event the run still records can be replayed.
   */
  async replay(eventId: string): Promise<MockCallbackSendResult & { missing: boolean }> {
    const known = this.#options.state.events.some((event) => event.eventId === eventId);
    const envelope = this.#archive.get(eventId);
    if (!known || envelope === undefined) {
      return { delivery: undefined, missing: true };
    }
    const result = await this.send(envelope, { encrypted: true, record: false });
    return { ...result, missing: false };
  }

  /** Sends one envelope and records its delivery summary. */
  async send(
    payload: unknown,
    options: MockCallbackSendOptions = {},
  ): Promise<MockCallbackSendResult> {
    const envelope = payload as MockCallbackEnvelope;
    if (this.#inFlight >= MOCK_CALLBACK_MAX_IN_FLIGHT) {
      return { delivery: undefined, error: mockError(6, "mock_callback_capacity_exceeded") };
    }
    // A replay keeps an existing identity, so it never needs new capacity.
    if (options.record !== false && this.#options.state.events.length >= MOCK_EVENT_MAX_RECORDS) {
      return { delivery: undefined, error: mockError(6, "mock_event_capacity_exceeded") };
    }
    this.#inFlight += 1;
    let delivery: MockCallbackDelivery | undefined;
    const { lifecycle, state, app } = this.#options;
    // A URL verification handshake is not a v2 envelope, so the task name is
    // derived from the payload shape and made unique per send.
    const name = isCallbackEnvelope(envelope)
      ? `callback:${envelope.header.event_id}`
      : `callback:handshake:${randomBytes(6).toString("hex")}`;
    try {
      await lifecycle.startTask(name, async (context) => {
        const wire = encodeRawCallback(envelope, app, {
          encrypted: options.encrypted ?? true,
          now: this.#options.now,
        });
        const outcome = await this.#post(wire, () => context.aborted, options.readBody === true);
        delivery = outcome;
        // Only a v2 business envelope is an event; a URL verification
        // handshake is not recorded in the event ledger, and a replay keeps
        // the original identity instead of adding a new one.
        if (isCallbackEnvelope(envelope) && options.record !== false) {
          this.#archive.set(envelope.header.event_id, envelope);
          context.commit(() => {
            state.events.push({
              eventId: envelope.header.event_id,
              eventType: envelope.header.event_type,
              delivered: outcome.ok,
            });
          });
        }
      });
    } catch {
      delivery = { ok: false, statusCode: null, summary: { ok: false, statusCode: null } };
    } finally {
      this.#inFlight -= 1;
    }
    if (delivery === undefined) {
      delivery = { ok: false, statusCode: null, summary: { ok: false, statusCode: null } };
    }
    return { delivery };
  }

  #post(wire: MockCallbackWire, aborted: () => boolean, readBody: boolean): Promise<MockCallbackDelivery> {
    return new Promise((resolvePromise) => {
      const destination = new URL(this.#options.destination);
      let settled = false;
      const finish = (delivery: MockCallbackDelivery) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        resolvePromise(delivery);
      };
      const call = request(
        {
          protocol: destination.protocol,
          hostname: destination.hostname,
          port: destination.port,
          path: `${destination.pathname}${destination.search}`,
          method: "POST",
          headers: {
            ...wire.headers,
            "content-length": String(wire.body.length),
          },
        },
        (response) => {
          // The status alone decides the outcome; the body is only kept when a
          // caller needs it, and a redirect is never followed.
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            if (readBody) chunks.push(chunk);
          });
          response.on("end", () => {
            const statusCode = response.statusCode ?? 0;
            const ok = statusCode >= 200 && statusCode < 300;
            const body = readBody ? Buffer.concat(chunks).toString("utf8") : undefined;
            finish({ ok, statusCode, summary: { ok, statusCode }, body });
          });
        },
      );
      call.on("error", () => finish({ ok: false, statusCode: null, summary: { ok: false, statusCode: null } }));
      const timer = setTimeout(() => {
        call.destroy();
        finish({ ok: false, statusCode: null, summary: { ok: false, statusCode: null } });
      }, MOCK_CALLBACK_TIMEOUT_MS);
      timer.unref?.();
      const poller = setInterval(() => {
        if (!aborted()) return;
        call.destroy();
        finish({ ok: false, statusCode: null, summary: { ok: false, statusCode: null } });
      }, 5);
      poller.unref?.();
      call.end(wire.body);
    });
  }
}
