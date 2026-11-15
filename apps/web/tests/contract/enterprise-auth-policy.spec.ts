import { describe, expect, it, vi } from "vitest";

import { createAuth } from "@megaui/auth";

function authWithMode(resolveMode: () => "legacy" | "enterprise" | "maintenance" | "reject") {
  const pairingPort = vi.fn(async () => ({ kind: "accepted" as const, status: 202 as const,
    body: { pairingId: "00000000-0000-0000-0000-000000000001", pairingToken: "A".repeat(43), expiresIn: 120 as const, resendAfter: 60 as const } }));
  return createAuth({
    appName: "megaui-policy-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://127.0.0.1:3000",
    db: {} as never,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: "test",
    enterprisePairing: { pairingPort, resolveTransport: () => ({ peerAddress: "192.0.2.1" }) },
    enterpriseOperationPolicy: { resolveMode, httpBasePath: "/api/auth" },
  });
}

describe("FS-19 enterprise auth operation policy", () => {
  it("allows only the six exact HTTP operations and rejects path variants/admin/delete", async () => {
    const auth = authWithMode(() => "enterprise");
    const request = async (path: string) => auth.handler(new Request(`http://127.0.0.1:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ alias: "alice" }),
    }));

    expect((await request("/enterprise/request")).status).toBe(202);
    for (const path of ["/enterprise/request/", "/sign-in/email", "/admin/update-user", "/delete-user", "/enterprise/request%2f"]) {
      expect((await request(path)).status).toBe(404);
    }
  });

  it("applies the same allowlist to direct auth.api dispatch and fails closed on policy drift", async () => {
    let mode: "enterprise" | "reject" = "enterprise";
    const auth = authWithMode(() => mode);
    await expect(auth.api.signUpEmail({ body: { email: "a@example.com", password: "a-password", name: "A" } })).rejects.toMatchObject({
      status: "NOT_FOUND",
    });
    await expect(auth.api.deleteUser({ body: {} })).rejects.toMatchObject({ status: "NOT_FOUND" });
    mode = "reject";
    const response = await auth.handler(new Request("http://127.0.0.1:3000/api/auth/enterprise/request", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ alias: "alice" }),
    }));
    expect(response.status).toBe(503);
  });

  it("keeps the legacy API unchanged and does not restore it after a persistent activation marker", async () => {
    let mode: "legacy" | "enterprise" = "legacy";
    const auth = authWithMode(() => mode);
    const legacy = await auth.handler(new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ email: "a@example.com", password: "a-password" }),
    }));
    expect(legacy.status).not.toBe(404);
    mode = "enterprise";
    const enterprise = await auth.handler(new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ email: "a@example.com", password: "a-password" }),
    }));
    expect(enterprise.status).toBe(404);
  });
});
