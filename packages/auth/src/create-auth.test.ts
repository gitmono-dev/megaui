import { describe, expect, it, vi } from "vitest";
import type { EmailSender } from "@megaui/email";
import { resolveSocialProviders } from "./social-providers";

/**
 * createAuth pulls in better-auth + drizzle; keep this file focused on the
 * OAuth fail-closed contract that the card AC names, and a lightweight
 * smoke that `createAuth` does not throw when OAuth env is empty.
 */
describe("createAuth OAuth wiring contract", () => {
  it("exposes empty socialProviders when credentials are absent", async () => {
    // Dynamic import so vitest can still collect when better-auth types lag.
    const { createAuth } = await import("./create-auth");

    const email = {
      sendVerificationEmail: vi.fn(),
      sendResetPasswordEmail: vi.fn(),
      sendEmail: vi.fn(),
      sendProductNotificationEmail: vi.fn(),
    } as unknown as EmailSender;

    // Minimal drizzle-shaped stub — createAuth only passes `db` into the
    // adapter factory; we never hit the database in this unit test.
    const db = {} as never;

    expect(() =>
      createAuth({
        appName: "megaui-test",
        secret: "test-secret-at-least-32-characters-long",
        baseURL: "http://localhost:3000",
        db,
        email,
        socialProviders: {},
        trustedOrigins: { appBaseUrl: "http://localhost:3000" },
        nodeEnv: "test",
      }),
    ).not.toThrow();

    expect(resolveSocialProviders({})).toEqual({});
  });

  it("requires appName / secret / baseURL (fail-closed)", async () => {
    const { createAuth } = await import("./create-auth");
    const email = {
      sendVerificationEmail: vi.fn(),
      sendResetPasswordEmail: vi.fn(),
    } as unknown as EmailSender;

    expect(() =>
      createAuth({
        appName: "  ",
        secret: "test-secret-at-least-32-characters-long",
        baseURL: "http://localhost:3000",
        db: {} as never,
        email,
      }),
    ).toThrow(/appName/);
  });
});
