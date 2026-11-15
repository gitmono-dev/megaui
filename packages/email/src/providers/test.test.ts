import { describe, expect, it } from "vitest";
import { createTestEmailProvider } from "./test";

describe("test email provider (PK-07 AC 1 — test provider capture)", () => {
  it("captures a sent email and returns success + an id", async () => {
    const provider = createTestEmailProvider();
    const response = await provider.send({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(response.success).toBe(true);
    expect(response.id).toBeTruthy();

    const last = provider.getLast();
    expect(last).toMatchObject({
      to: "user@example.com",
      from: "hello@deploy.example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(last?.recordedAt).toBeTruthy();
  });

  it("accumulates every sent email in order and exposes them via getAll", async () => {
    const provider = createTestEmailProvider();
    await provider.send({ to: "a@x.com", from: "f@x.com", subject: "1", html: "<p>1</p>" });
    await provider.send({ to: "b@x.com", from: "f@x.com", subject: "2", html: "<p>2</p>" });

    const all = provider.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]?.subject).toBe("1");
    expect(all[1]?.subject).toBe("2");
    expect(provider.getLast()?.subject).toBe("2");
  });

  it("returns undefined from getLast when nothing has been sent", () => {
    const provider = createTestEmailProvider();
    expect(provider.getLast()).toBeUndefined();
    expect(provider.getAll()).toEqual([]);
  });

  it("clear() empties the recordings", async () => {
    const provider = createTestEmailProvider();
    await provider.send({ to: "a@x.com", from: "f@x.com", subject: "1", html: "<p>1</p>" });
    provider.clear();
    expect(provider.getAll()).toEqual([]);
    expect(provider.getLast()).toBeUndefined();
  });

  it("isolates recordings across separate provider instances (GC-09 — no shared global state)", async () => {
    const providerA = createTestEmailProvider();
    const providerB = createTestEmailProvider();
    await providerA.send({ to: "a@x.com", from: "f@x.com", subject: "only-a", html: "<p>a</p>" });

    expect(providerA.getAll()).toHaveLength(1);
    expect(providerB.getAll()).toHaveLength(0);
  });
});
