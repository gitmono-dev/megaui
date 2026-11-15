import { describe, expect, it, vi } from "vitest";

import { createAuth } from "@megaui/auth";

const mode = async () => "maintenance" as const;

function maintenanceAuth() {
  const readEnterpriseAuthority = vi.fn(async () => {
    throw new Error("maintenance must not read enterprise session metadata");
  });
  const readEnterpriseProfile = vi.fn(async () => {
    throw new Error("maintenance must not read enterprise profile");
  });
  const qualifyEnterprise = vi.fn(async () => {
    throw new Error("maintenance must not qualify enterprise session");
  });
  const auth = createAuth({
    appName: "megaui-fs77",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    db: {} as never,
    email: {
      sendVerificationEmail: vi.fn(),
      sendResetPasswordEmail: vi.fn(),
      sendEmail: vi.fn(),
      sendProductNotificationEmail: vi.fn(),
    } as never,
    nodeEnv: "test",
    trustedOrigins: { appBaseUrl: "http://localhost:3000" },
    enterpriseOperationPolicy: { httpBasePath: "/api/auth", resolveMode: mode },
    enterprisePairing: {
      pairingPort: vi.fn(async () => ({ kind: "unavailable" as const })),
      statusPort: vi.fn(async () => ({ kind: "unavailable" as const })),
      resolveTransport: () => ({ peerAddress: "192.0.2.1" }),
      verifyPort: vi.fn(async () => ({ kind: "unavailable" as const })),
    },
    enterpriseSession: {
      resolveMode: mode,
      readEnterpriseAuthority,
      readEnterpriseProfile,
      qualifyEnterprise,
    },
  });
  return { auth, readEnterpriseAuthority, readEnterpriseProfile, qualifyEnterprise };
}

describe("FS-77 maintenance authentication boundary", () => {
  it("rejects enterprise writes while returning null for both session endpoints", async () => {
    const { auth, readEnterpriseAuthority, readEnterpriseProfile, qualifyEnterprise } = maintenanceAuth();
    const request = (path: string, method = "POST", body?: unknown) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
      method,
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

    for (const path of ["/enterprise/request", "/enterprise/status", "/enterprise/verify"]) {
      expect((await request(path)).status).toBe(404);
    }
    expect((await request("/get-session", "GET")).status).toBe(200);
    expect(await (await request("/get-session", "GET")).json()).toBeNull();
    expect((await request("/enterprise/session", "GET")).status).toBe(200);
    expect(await (await request("/enterprise/session", "GET")).json()).toBeNull();
    expect(readEnterpriseAuthority).not.toHaveBeenCalled();
    expect(readEnterpriseProfile).not.toHaveBeenCalled();
    expect(qualifyEnterprise).not.toHaveBeenCalled();
  });

  it("applies the same maintenance gate to direct auth.api calls and keeps sign-out reachable", async () => {
    const { auth } = maintenanceAuth();
    await expect(auth.api.signUpEmail({ body: { email: "blocked@example.test", password: "password-at-least-12", name: "Blocked" } })).rejects.toMatchObject({ status: "NOT_FOUND" });
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
    await expect(auth.api.getEnterpriseSession({ headers: new Headers() })).resolves.toBeNull();
    const signOut = await auth.handler(new Request("http://localhost:3000/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    }));
    expect(signOut.status).not.toBe(404);
  });
});
