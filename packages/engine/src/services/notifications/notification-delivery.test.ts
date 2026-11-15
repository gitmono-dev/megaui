import { describe, expect, it, vi } from "vitest";
import {
  compareBearerToken,
  deliverNotificationEmail,
  extractBearerToken,
} from "./notification-delivery";
import type { EmailDeliveryPort, NotificationEmailParams } from "./types";

const EMAIL_PARAMS: NotificationEmailParams = {
  to: "eleanor@example.com",
  eventType: "issue.comment.created",
  ctaUrl: "https://example.test/issues/42",
  payload: { actorUsername: "rafael" },
};

describe("compareBearerToken (EG-09 AC4: constant-time bearer compare, GC-07/ER-11)", () => {
  const secret = "s3cr3t-mega2-mail-bearer";

  it("returns true only for the exact secret", () => {
    expect(compareBearerToken(secret, secret)).toBe(true);
    expect(compareBearerToken("wrong-token", secret)).toBe(false);
  });

  it("returns false (never throws) for a provided token of a different length than the secret", () => {
    expect(() => compareBearerToken("short", secret)).not.toThrow();
    expect(compareBearerToken("short", secret)).toBe(false);
    expect(() => compareBearerToken(`${secret}-and-then-some-extra`, secret)).not.toThrow();
    expect(compareBearerToken(`${secret}-and-then-some-extra`, secret)).toBe(false);
  });

  it("fails closed for null/undefined/empty provided tokens", () => {
    expect(compareBearerToken(null, secret)).toBe(false);
    expect(compareBearerToken(undefined, secret)).toBe(false);
    expect(compareBearerToken("", secret)).toBe(false);
  });

  it("fails closed when the configured secret itself is empty (misconfiguration must never grant access)", () => {
    expect(compareBearerToken("anything", "")).toBe(false);
    expect(compareBearerToken("", "")).toBe(false);
  });

  it("never logs the secret or the provided token (ER-11)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      compareBearerToken("wrong-token", secret);
      compareBearerToken(secret, secret);
      for (const spy of [logSpy, errorSpy, warnSpy]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization header, case-insensitively", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer   abc123  ")).toBe("abc123");
  });

  it("returns null for missing/malformed headers without throwing", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer   ")).toBeNull();
  });
});

describe("deliverNotificationEmail (EG-09 AC3: email delivery failure must not block in-app write)", () => {
  it("returns { ok: false, code: 'no_provider' } (never throws) when no port is configured", async () => {
    await expect(deliverNotificationEmail(undefined, EMAIL_PARAMS)).resolves.toEqual({
      ok: false,
      code: "no_provider",
    });
  });

  it("returns { ok: true } when the port succeeds", async () => {
    const port: EmailDeliveryPort = { send: vi.fn().mockResolvedValue({ ok: true }) };
    await expect(deliverNotificationEmail(port, EMAIL_PARAMS)).resolves.toEqual({ ok: true });
  });

  it("isolates a typed provider failure into a data result instead of throwing", async () => {
    const port: EmailDeliveryPort = {
      send: vi.fn().mockResolvedValue({ ok: false, message: "template payload invalid" }),
    };
    await expect(deliverNotificationEmail(port, EMAIL_PARAMS)).resolves.toEqual({
      ok: false,
      code: "delivery_failed",
      message: "template payload invalid",
    });
  });

  it("isolates a thrown/rejected provider error into a data result instead of propagating (AC3 core assertion)", async () => {
    const port: EmailDeliveryPort = {
      send: vi.fn().mockRejectedValue(new Error("SMTP connection refused")),
    };
    await expect(deliverNotificationEmail(port, EMAIL_PARAMS)).resolves.toEqual({
      ok: false,
      code: "delivery_failed",
      message: "SMTP connection refused",
    });
  });

  it("isolates a non-Error throw (e.g. a rejected string) without crashing the caller", async () => {
    const port: EmailDeliveryPort = { send: vi.fn().mockRejectedValue("boom") };
    const result = await deliverNotificationEmail(port, EMAIL_PARAMS);
    expect(result).toEqual({
      ok: false,
      code: "delivery_failed",
      message: "unknown email delivery error",
    });
  });
});
