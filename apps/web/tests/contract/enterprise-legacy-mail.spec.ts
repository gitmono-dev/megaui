import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as postInternalEmail } from "../../app/api/internal/notifications/email/route";
import {
  MemoryIdempotencyStore,
  setInternalEmailIdempotencyStoreForTests,
  setInternalEmailSenderForTests,
} from "../../lib/internal/notifications-email";

const endpoint = "http://127.0.0.1:3000/api/internal/notifications/email";
const bearer = "fs50-legacy-mail-bearer";

const payload = {
  event_type: "issue.comment.created",
  recipient: { username: "tester", email: "tester@example.com" },
  locale: "en",
  payload: {
    actorUsername: "alice",
    issueLink: "https://example.com/issues/1",
    issueTitle: "Bug",
    commentExcerpt: "Looks good",
  },
};

function request(body: unknown = payload, headers: Record<string, string> = {}): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `fs50-${randomUUID()}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  setInternalEmailSenderForTests(null);
  setInternalEmailIdempotencyStoreForTests(null);
});

describe("FS-50 legacy internal notification email boundary", () => {
  it("retires the old endpoint in enterprise mode before bearer validation", async () => {
    vi.stubEnv("AUTH_MODE", "enterprise");
    const response = await postInternalEmail(request(payload, { Authorization: "Bearer wrong" }));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "retired" });
  });

  it("keeps the legacy bearer contract and accepts a valid product notification", async () => {
    vi.stubEnv("AUTH_MODE", "legacy");
    vi.stubEnv("MEGA2_INTERNAL_MAIL_BEARER", bearer);
    const sender = vi.fn(async () => ({ ok: true as const }));
    setInternalEmailSenderForTests(sender);
    setInternalEmailIdempotencyStoreForTests(new MemoryIdempotencyStore());

    const response = await postInternalEmail(request());

    expect(response.status).toBe(202);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("rejects compatibility identity.invalid addresses before sending", async () => {
    vi.stubEnv("AUTH_MODE", "legacy");
    vi.stubEnv("MEGA2_INTERNAL_MAIL_BEARER", bearer);
    const sender = vi.fn(async () => ({ ok: true as const }));
    setInternalEmailSenderForTests(sender);
    setInternalEmailIdempotencyStoreForTests(new MemoryIdempotencyStore());

    const response = await postInternalEmail(request({
      ...payload,
      recipient: { username: "tester", email: "u_abc@identity.invalid" },
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_payload" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("rejects unknown authentication events in legacy mode", async () => {
    vi.stubEnv("AUTH_MODE", "legacy");
    vi.stubEnv("MEGA2_INTERNAL_MAIL_BEARER", bearer);
    setInternalEmailIdempotencyStoreForTests(new MemoryIdempotencyStore());

    const response = await postInternalEmail(request({ ...payload, event_type: "auth.login" }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_event" });
  });
});
