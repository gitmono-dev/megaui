import { describe, expect, it, vi } from "vitest";
import { createSmtpEmailProvider, type SmtpTransport } from "./smtp";

describe("smtp email provider (PK-07 AC 1 — interface stub, no real send)", () => {
  const baseConfig = { host: "smtp.example.internal", port: 587 };

  it("sends via the injected transport seam and maps the result", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>(async () => ({ messageId: "smtp-abc" }));
    const provider = createSmtpEmailProvider({ config: baseConfig, transport: { sendMail } });

    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(response).toEqual({ success: true, id: "smtp-abc" });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("passes through cc/bcc/replyTo when present", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>(async () => ({ messageId: "smtp-1" }));
    const provider = createSmtpEmailProvider({ config: baseConfig, transport: { sendMail } });

    await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      cc: ["cc@example.com"],
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
    });

    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      cc: ["cc@example.com"],
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
    });
  });

  it("maps a transport rejection to a domain error response rather than throwing", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>(async () => {
      throw new Error("connection refused");
    });
    const provider = createSmtpEmailProvider({ config: baseConfig, transport: { sendMail } });

    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatchObject({ name: "SmtpError", provider: "smtp", message: "connection refused" });
  });

  it("fail-closes at construction when host is missing (GC-07)", () => {
    expect(() =>
      createSmtpEmailProvider({ config: { host: "", port: 587 }, transport: { sendMail: vi.fn() } }),
    ).toThrow(/host/i);
  });

  it("fail-closes at construction when port is missing (GC-07)", () => {
    expect(() =>
      createSmtpEmailProvider({
        config: { host: "smtp.example.internal", port: 0 },
        transport: { sendMail: vi.fn() },
      }),
    ).toThrow(/port/i);
  });

  it("never constructs a real transport when one is injected (no real send)", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>(async () => ({ messageId: "smtp-2" }));
    // A bogus host/port would fail fast for a real connection; success here proves
    // the injected stub — not a real socket — handled the send.
    const provider = createSmtpEmailProvider({
      config: { host: "203.0.113.1", port: 1 },
      transport: { sendMail },
    });

    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });

    expect(response).toEqual({ success: true, id: "smtp-2" });
  });
});
