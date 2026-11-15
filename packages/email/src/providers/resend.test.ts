import { describe, expect, it, vi } from "vitest";
import { createResendEmailProvider, type ResendClientLike } from "./resend";

describe("resend email provider (PK-07 AC 1 — interface stub, no real send)", () => {
  const baseConfig = { apiKey: "re_test_key" };

  it("sends via the injected client seam and maps a successful response", async () => {
    const send = vi.fn<ResendClientLike["emails"]["send"]>(async () => ({
      data: { id: "resend-abc" },
      error: null,
    }));
    const provider = createResendEmailProvider({ config: baseConfig, client: { emails: { send } } });

    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(response).toEqual({ success: true, id: "resend-abc" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("maps a Resend API error to a domain error response", async () => {
    const send = vi.fn<ResendClientLike["emails"]["send"]>(async () => ({
      data: null,
      error: { message: "invalid `to` field" },
    }));
    const provider = createResendEmailProvider({ config: baseConfig, client: { emails: { send } } });

    const response = await provider.send({
      to: "not-an-email",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatchObject({
      name: "ResendError",
      provider: "resend",
      message: "invalid `to` field",
    });
  });

  it("maps a client-level rejection to a domain error response rather than throwing", async () => {
    const send = vi.fn<ResendClientLike["emails"]["send"]>(async () => {
      throw new Error("network error");
    });
    const provider = createResendEmailProvider({ config: baseConfig, client: { emails: { send } } });

    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatchObject({ name: "ResendError", provider: "resend", message: "network error" });
  });

  it("fail-closes at construction when apiKey is missing (GC-07)", () => {
    expect(() =>
      createResendEmailProvider({ config: { apiKey: "" }, client: { emails: { send: vi.fn() } } }),
    ).toThrow(/apiKey/i);
  });

  it("never constructs a real Resend client when one is injected (no real send)", async () => {
    const send = vi.fn<ResendClientLike["emails"]["send"]>(async () => ({
      data: { id: "resend-2" },
      error: null,
    }));
    const provider = createResendEmailProvider({ config: baseConfig, client: { emails: { send } } });

    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });

    expect(response).toEqual({ success: true, id: "resend-2" });
  });
});
