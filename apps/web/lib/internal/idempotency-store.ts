// megaui:libs/email/internal/idempotency-store.ts@0ff3a9d

import { createHash, randomUUID } from "node:crypto";

export type IdempotencyState = "in_progress" | "succeeded" | "failed";

export type IdempotencyRecord = {
  deliveryId: string;
  fingerprint: string;
  state: IdempotencyState;
};

export type ReserveResult =
  | { kind: "fresh"; deliveryId: string }
  | { kind: "duplicate"; deliveryId: string }
  | { kind: "awaiting"; deliveryId: string }
  | { kind: "conflict" }
  | { kind: "retry"; deliveryId: string };

/**
 * Process-local idempotency store for internal product email acceptance.
 */
export class MemoryIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  clear(): void {
    this.records.clear();
  }

  get(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  reserve(key: string, fingerprint: string): ReserveResult {
    const existing = this.records.get(key);
    if (!existing) {
      const deliveryId = randomUUID();
      this.records.set(key, {
        deliveryId,
        fingerprint,
        state: "in_progress",
      });
      return { kind: "fresh", deliveryId };
    }

    if (existing.fingerprint !== fingerprint) {
      return { kind: "conflict" };
    }

    if (existing.state === "succeeded") {
      return { kind: "duplicate", deliveryId: existing.deliveryId };
    }

    if (existing.state === "in_progress") {
      return { kind: "awaiting", deliveryId: existing.deliveryId };
    }

    existing.state = "in_progress";
    return { kind: "retry", deliveryId: existing.deliveryId };
  }

  markSucceeded(key: string): void {
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }
    existing.state = "succeeded";
  }

  markFailed(key: string): void {
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }
    existing.state = "failed";
  }
}

export const defaultIdempotencyStore = new MemoryIdempotencyStore();

export function fingerprintInternalEmailBody(body: {
  event_type: string;
  recipient: { username: string; email: string };
  locale: string;
  payload: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    event_type: body.event_type,
    recipient: {
      username: body.recipient.username,
      email: body.recipient.email,
    },
    locale: body.locale,
    payload: body.payload,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
