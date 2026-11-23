// megaui:libs/email/internal/notifications-email.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-05):
// - Bearer verify via `@megaui/engine` (`compareBearerToken` / `extractBearerToken`).
// - Production send via `createEmailSender` from `@megaui/email`.

import { randomUUID } from "node:crypto";

import { resolveAuthMode } from "@megaui/core";
import {
  createEmailSender,
  generateProductNotificationEmail,
  isProductEventType,
  type EmailTemplate,
  type ProductEventType,
} from "@megaui/email";

import { extractBearerToken, verifyInternalMailBearer } from "./bearer";
import {
  defaultIdempotencyStore,
  fingerprintInternalEmailBody,
  type IdempotencyRecord,
  type MemoryIdempotencyStore as MemoryIdempotencyStoreType,
} from "./idempotency-store";

export { MemoryIdempotencyStore } from "./idempotency-store";

export type InternalEmailErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "retired"
  | "unsupported_event"
  | "invalid_payload"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "upstream_unavailable";

type ErrorBody = {
  code: InternalEmailErrorCode;
  message: string;
};

export type ProductEmailSendArgs = {
  to: string;
  template: EmailTemplate;
  eventType: ProductEventType;
  deliveryId: string;
  idempotencyKey: string;
};

export type ProductEmailSender = (
  args: ProductEmailSendArgs,
) => Promise<{ ok: true } | { ok: false; message?: string }>;

function createProductionSender(): ProductEmailSender {
  const sender = createEmailSender({
    defaultFrom: process.env.EMAIL_DEFAULT_FROM?.trim() || "noreply@example.com",
    provider: { kind: (process.env.EMAIL_PROVIDER?.trim() || "test") as "test" },
  });
  return async (args) => {
    const result = await sender.sendEmail({
      to: args.to,
      subject: args.template.subject,
      html: args.template.html,
    });
    if (result.success) {
      return { ok: true };
    }
    return { ok: false, message: result.error?.message || "email provider failed" };
  };
}

let productEmailSender: ProductEmailSender = createProductionSender();
let idempotencyStore: MemoryIdempotencyStoreType = defaultIdempotencyStore;

/**
 * Resolve the mode needed by this legacy-only entry point without opening a
 * database, through `resolveAuthMode` (FSL-132). Feishu mode is retired, and a
 * pair `resolveAuthMode` refuses fails closed as retired rather than
 * accidentally preserving the old API.
 */
export function resolveInternalEmailMode(source: NodeJS.Dict<string> = process.env): "legacy" | "retired" {
  try {
    return resolveAuthMode({ AUTH_MODE: source.AUTH_MODE, AUTH_PROVIDER: source.AUTH_PROVIDER }).mode === "legacy"
      ? "legacy"
      : "retired";
  } catch {
    return "retired";
  }
}

export function setInternalEmailSenderForTests(sender: ProductEmailSender | null): void {
  productEmailSender = sender ?? createProductionSender();
}

export function setInternalEmailIdempotencyStoreForTests(
  store: MemoryIdempotencyStoreType | null,
): void {
  idempotencyStore = store ?? defaultIdempotencyStore;
}

function isCompatibilityRecipient(value: string): boolean {
  return /(?:^|[<@\s])identity\.invalid(?:[>\s,;]|$)/iu.test(value);
}

function jsonError(status: number, code: InternalEmailErrorCode, message: string): Response {
  const body: ErrorBody = { code, message };
  return Response.json(body, { status });
}

async function waitForIdempotencyTerminal(
  key: string,
  timeoutMs = 2_000,
  intervalMs = 5,
): Promise<IdempotencyRecord | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = idempotencyStore.get(key);
    if (!current || current.state !== "in_progress") {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return idempotencyStore.get(key);
}

async function sendAndFinalize(args: {
  email: string;
  template: EmailTemplate;
  eventType: ProductEventType;
  deliveryId: string;
  idempotencyKey: string;
}): Promise<Response> {
  const sendResult = await productEmailSender({
    to: args.email,
    template: args.template,
    eventType: args.eventType,
    deliveryId: args.deliveryId,
    idempotencyKey: args.idempotencyKey,
  });

  if (!sendResult.ok) {
    idempotencyStore.markFailed(args.idempotencyKey);
    return jsonError(
      503,
      "upstream_unavailable",
      sendResult.message || "email provider failed",
    );
  }

  idempotencyStore.markSucceeded(args.idempotencyKey);
  return Response.json(
    {
      delivery_id: args.deliveryId,
      accepted: true,
      duplicate: false,
    },
    { status: 202 },
  );
}

/** Handle POST /api/internal/notifications/email. */
export async function handleInternalNotificationEmail(request: Request): Promise<Response> {
  if (resolveInternalEmailMode() !== "legacy") {
    return jsonError(410, "retired", "internal notification email is retired in enterprise mode");
  }

  if (request.method !== "POST") {
    return jsonError(405, "invalid_request", "method not allowed");
  }

  const authorization = request.headers.get("authorization");
  if (!verifyInternalMailBearer(authorization)) {
    if (extractBearerToken(authorization) || authorization) {
      console.warn("internal email: unauthorized request");
    } else {
      console.warn("internal email: missing bearer");
    }
    return jsonError(401, "unauthorized", "missing or invalid bearer");
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    return jsonError(400, "invalid_request", "Idempotency-Key header is required");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "request body must be valid JSON");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "invalid_request", "request body must be a JSON object");
  }

  const record = body as Record<string, unknown>;
  const eventType = record.event_type;
  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return jsonError(400, "invalid_request", "event_type is required");
  }
  if (!isProductEventType(eventType)) {
    return jsonError(422, "unsupported_event", `unsupported event_type: ${eventType}`);
  }

  const recipient = record.recipient;
  if (recipient === null || typeof recipient !== "object" || Array.isArray(recipient)) {
    return jsonError(400, "invalid_request", "recipient is required");
  }
  const recipientRecord = recipient as Record<string, unknown>;
  const username = recipientRecord.username;
  const email = recipientRecord.email;
  if (typeof username !== "string" || username.trim().length === 0) {
    return jsonError(400, "invalid_request", "recipient.username is required");
  }
  if (typeof email !== "string" || email.trim().length === 0) {
    return jsonError(400, "invalid_request", "recipient.email is required");
  }
  if (isCompatibilityRecipient(email)) {
    return jsonError(422, "invalid_payload", "recipient.email cannot use a compatibility address");
  }

  const locale = record.locale;
  if (typeof locale !== "string" || locale.trim().length === 0) {
    return jsonError(400, "invalid_request", "locale is required");
  }

  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError(400, "invalid_request", "payload must be an object");
  }

  const payloadRecord = payload as Record<string, unknown>;
  const ctaUrl =
    (typeof payloadRecord.issueLink === "string" && payloadRecord.issueLink)
    || (typeof payloadRecord.clLink === "string" && payloadRecord.clLink)
    || (typeof payloadRecord.referencedLink === "string" && payloadRecord.referencedLink)
    || (typeof payloadRecord.sourceLink === "string" && payloadRecord.sourceLink)
    || "https://example.com";
  const appName = process.env.MEGA_SITE_NAME?.trim() || process.env.MEGA_PRODUCT_NAME?.trim() || "Mega";

  const rendered = generateProductNotificationEmail({
    eventType,
    recipientUsername: username,
    locale,
    ctaUrl,
    appName,
    payload: payloadRecord,
  });
  if (!rendered.ok) {
    return jsonError(422, rendered.code, rendered.message);
  }

  const fingerprint = fingerprintInternalEmailBody({
    event_type: eventType,
    recipient: { username, email },
    locale,
    payload: payload as Record<string, unknown>,
  });

  let reserved = idempotencyStore.reserve(idempotencyKey, fingerprint);
  if (reserved.kind === "conflict") {
    return jsonError(409, "idempotency_conflict", "Idempotency-Key conflict");
  }
  if (reserved.kind === "duplicate") {
    return Response.json(
      {
        delivery_id: reserved.deliveryId,
        accepted: true,
        duplicate: true,
      },
      { status: 202 },
    );
  }
  if (reserved.kind === "awaiting") {
    const terminal = await waitForIdempotencyTerminal(idempotencyKey);
    if (terminal?.state === "succeeded" && terminal.fingerprint === fingerprint) {
      return Response.json(
        {
          delivery_id: terminal.deliveryId,
          accepted: true,
          duplicate: true,
        },
        { status: 202 },
      );
    }
    if (terminal?.state === "failed" && terminal.fingerprint === fingerprint) {
      reserved = idempotencyStore.reserve(idempotencyKey, fingerprint);
      if (reserved.kind !== "retry" && reserved.kind !== "fresh") {
        return jsonError(
          425,
          "idempotency_in_progress",
          "Idempotency-Key retry is already in progress; retry the same key",
        );
      }
    } else if (terminal && terminal.fingerprint !== fingerprint) {
      return jsonError(409, "idempotency_conflict", "Idempotency-Key conflict");
    } else {
      return jsonError(
        425,
        "idempotency_in_progress",
        "Idempotency-Key is still in progress; retry the same key",
      );
    }
  }

  const deliveryId = reserved.deliveryId || randomUUID();
  return sendAndFinalize({
    email,
    template: rendered.template,
    eventType,
    deliveryId,
    idempotencyKey,
  });
}
