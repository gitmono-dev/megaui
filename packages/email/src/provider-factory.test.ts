import { describe, expect, it, vi } from "vitest";
import { createEmailProvider } from "./provider-factory";
import { createTestEmailProvider } from "./providers/test";
import type { ResendClientLike } from "./providers/resend";
import type { SmtpTransport } from "./providers/smtp";

describe("createEmailProvider factory (PK-07 — test / smtp / resend only)", () => {
  it("wires the test provider and defaults to a fresh in-memory store", async () => {
    const provider = createEmailProvider({ kind: "test" });
    await provider.send({ to: "a@x.com", from: "f@x.com", subject: "s", html: "<p>h</p>" });
    expect(await provider.send({ to: "b@x.com", from: "f@x.com", subject: "s2", html: "<p>h2</p>" })).toMatchObject({
      success: true,
    });
  });

  it("wires the test provider using an explicitly injected TestEmailProvider (assertion access)", async () => {
    const injected = createTestEmailProvider();
    const provider = createEmailProvider({ kind: "test", provider: injected });
    await provider.send({ to: "a@x.com", from: "f@x.com", subject: "s", html: "<p>h</p>" });

    expect(injected.getAll()).toHaveLength(1);
    expect(injected.getLast()?.subject).toBe("s");
  });

  it("wires the smtp provider using the injected transport seam", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>(async () => ({ messageId: "smtp-x" }));
    const provider = createEmailProvider({
      kind: "smtp",
      config: { host: "smtp.example.internal", port: 587 },
      transport: { sendMail },
    });

    const response = await provider.send({ to: "a@x.com", from: "f@x.com", subject: "s", html: "<p>h</p>" });
    expect(response).toEqual({ success: true, id: "smtp-x" });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("wires the resend provider using the injected client seam", async () => {
    const send = vi.fn<ResendClientLike["emails"]["send"]>(async () => ({
      data: { id: "resend-x" },
      error: null,
    }));
    const provider = createEmailProvider({ kind: "resend", config: { apiKey: "re_key" }, client: { emails: { send } } });

    const response = await provider.send({ to: "a@x.com", from: "f@x.com", subject: "s", html: "<p>h</p>" });
    expect(response).toEqual({ success: true, id: "resend-x" });
    expect(send).toHaveBeenCalledOnce();
  });
});
