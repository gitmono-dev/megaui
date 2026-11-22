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

describe("createAuth without the enterprise plugin (FSL-133)", () => {
  const email = {
    sendVerificationEmail: vi.fn(),
    sendResetPasswordEmail: vi.fn(),
  } as unknown as EmailSender;
  const base = {
    appName: "megaui-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    db: {} as never,
    email,
    nodeEnv: "test",
  };
  const OLD_OPTIONS = ["enterprisePairing", "enterpriseOperationPolicy", "enterpriseSession"] as const;
  const OLD_PLUGIN_IDS = ["megaui-enterprise-operation-policy", "megaui-enterprise-public-session", "megaui-enterprise-pairing"];

  it("AC4: no longer accepts the enterprise options (type error; ignored at runtime)", async () => {
    const { createAuth } = await import("./create-auth");
    // @ts-expect-error FSL-133: `enterprisePairing` is not a `CreateAuthConfig` option any more.
    createAuth({ ...base, enterprisePairing: { pairingPort: vi.fn(), resolveTransport: () => null } });
    // @ts-expect-error FSL-133: `enterpriseOperationPolicy` is not a `CreateAuthConfig` option any more.
    createAuth({ ...base, enterpriseOperationPolicy: { resolveMode: () => "enterprise" } });
    // @ts-expect-error FSL-133: `enterpriseSession` is not a `CreateAuthConfig` option any more.
    createAuth({ ...base, enterpriseSession: {} });

    const forced = { ...base } as Record<string, unknown>;
    for (const option of OLD_OPTIONS) forced[option] = { pairingPort: vi.fn(), resolveTransport: () => null, resolveMode: () => "enterprise" };
    const plain = createAuth(base);
    const auth = createAuth(forced as unknown as Parameters<typeof createAuth>[0]);
    const ids = (auth.options.plugins ?? []).map(plugin => plugin.id);
    expect(ids).toEqual((plain.options.plugins ?? []).map(plugin => plugin.id));
    for (const id of OLD_PLUGIN_IDS) expect(ids).not.toContain(id);
    expect(Object.keys(auth.options.rateLimit?.customRules ?? {}).filter(path => path.startsWith("/enterprise/"))).toEqual([]);
    const paths = Object.values(auth.api as unknown as Record<string, { path?: unknown }>).map(endpoint => endpoint.path);
    expect(paths.filter(path => typeof path === "string" && path.startsWith("/enterprise/"))).toEqual([]);
  });

  it("AC5: the session declares no enterprise additional field", async () => {
    const { createAuth } = await import("./create-auth");
    const auth = createAuth(base);
    const session = auth.options.session as { additionalFields?: Record<string, unknown>; cookieCache?: { enabled?: boolean } };
    const fields = Object.keys(session.additionalFields ?? {});
    expect(fields).toEqual([]);
    for (const field of ["enterpriseGrantId", "enterpriseIdentityId", "authEpoch", "authMethod"]) expect(fields).not.toContain(field);
    expect(session.cookieCache?.enabled).toBe(false);
  });

  it("AC6: the root entry exports no enterprise API", async () => {
    const entry = await import("./index");
    const names = Object.keys(entry);
    expect(names.filter(name => /enterprise/i.test(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining([
      "AUTH_ROUTE_PREFIX", "createAuth", "feishuLogin", "generateFeishuLoginCode",
      "FEISHU_LOGIN_CODE_ALPHABET", "FEISHU_LOGIN_CODE_LENGTH",
    ]));
    expect(entry.AUTH_ROUTE_PREFIX).toBe("/api/auth");
  });
});
