import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../create-auth";
import { createEnterprisePairingPlugin, parseEnterpriseFlowCookie } from "./plugin";

describe("enterprise pairing Better Auth plugin (FS-73)", () => {
  it("parses one canonical flow cookie and rejects duplicates or malformed cookies", () => {
    const flow = "A".repeat(43);
    expect(parseEnterpriseFlowCookie(`theme=dark; __Host-megaui.enterprise-flow=${flow}`)).toBe(flow);
    expect(parseEnterpriseFlowCookie(`__Host-megaui.enterprise-flow=${flow}; __Host-megaui.enterprise-flow=${flow}`)).toBe("invalid");
    expect(parseEnterpriseFlowCookie("__Host-megaui.enterprise-flow=bad value")).toBe("invalid");
    expect(parseEnterpriseFlowCookie("theme=dark")).toBeUndefined();
    expect(parseEnterpriseFlowCookie(null)).toBeUndefined();
  });

  it("is opt-in, disables only the exact generic rate-limit bucket, and exposes one endpoint", () => {
    const port = vi.fn(async () => ({ kind: "unavailable" as const }));
    const plugin = createEnterprisePairingPlugin({
      pairingPort: port,
      resolveTransport: () => ({ peerAddress: "192.0.2.1" }),
    });
    expect(plugin.id).toBe("megaui-enterprise-pairing");
    expect(Object.keys(plugin.endpoints ?? {})).toEqual(["enterprisePairingRequest"]);

    const email = {
      sendVerificationEmail: vi.fn(),
      sendResetPasswordEmail: vi.fn(),
    } as never;
    const auth = createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://localhost:3000",
      db: {} as never,
      email,
      nodeEnv: "production",
      enterprisePairing: {
        pairingPort: port,
        resolveTransport: () => ({ peerAddress: "192.0.2.1" }),
      },
    });
    expect(auth.options.plugins?.some(candidate => candidate.id === plugin.id)).toBe(true);
    expect(auth.options.rateLimit?.customRules?.["/enterprise/request"]).toBe(false);
    expect(auth.options.rateLimit?.customRules?.["/enterprise/status"]).toBe(false);
  });

  it("runs through the actual createAuth handler and sets the bounded preauth cookie only after acceptance", async () => {
    const active = new WeakSet<Request>();
    const port = vi.fn(async ({ loginName }: { loginName: string }) => ({
      kind: "accepted" as const,
      status: 202 as const,
      body: {
        pairingId: loginName === "known" ? "00000000-0000-0000-0000-000000000001" : "00000000-0000-0000-0000-000000000002",
        pairingToken: "A".repeat(43),
        expiresIn: 120 as const,
        resendAfter: 60 as const,
      },
    }));
    const auth = createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://127.0.0.1:3000",
      db: {} as never,
      email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
      nodeEnv: "test",
      enterprisePairing: {
        pairingPort: port,
        resolveTransport: request => active.has(request) ? { peerAddress: "192.0.2.1" } : null,
      },
    });
    const call = async (alias: string) => {
      const request = new Request("http://127.0.0.1:3000/api/auth/enterprise/request", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
        body: JSON.stringify({ alias }),
      });
      active.add(request);
      try { return await auth.handler(request); } finally { active.delete(request); }
    };
    const known = await call("known");
    const unknown = await call("unknown");
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.headers.get("set-cookie")).toMatch(/^__Host-megaui\.enterprise-flow=.*Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(await known.json()).toMatchObject({ expiresIn: 120, resendAfter: 60 });
    expect(await unknown.json()).toMatchObject({ expiresIn: 120, resendAfter: 60 });
    expect(port).toHaveBeenCalledTimes(2);
  });

  it("exposes status only with the preauth flow and never returns request secrets", async () => {
    const pairingId = "00000000-0000-0000-0000-000000000001";
    const challengeId = "00000000-0000-0000-0000-000000000002";
    const statusPort = vi.fn(async ({ pairingId: id }: { pairingId: string }) => id === pairingId
      ? { kind: "confirmed" as const, challengeId }
      : { kind: "not-found" as const });
    const auth = createAuth({
      appName: "megaui-test",
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://127.0.0.1:3000",
      db: {} as never,
      email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
      nodeEnv: "test",
      enterprisePairing: {
        pairingPort: vi.fn(async () => ({ kind: "unavailable" as const })),
        statusPort,
        resolveTransport: () => ({ peerAddress: "192.0.2.1" }),
      },
    });
    const flow = "A".repeat(43);
    const cookie = `__Host-megaui.enterprise-flow=${flow}`;
    const status = await auth.handler(new Request("http://127.0.0.1:3000/api/auth/enterprise/status", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ pairingId }),
    }));
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ status: "confirmed", challengeId });
    expect(statusPort).toHaveBeenCalledTimes(1);

    const missingFlow = await auth.handler(new Request("http://127.0.0.1:3000/api/auth/enterprise/status", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ pairingId }),
    }));
    expect(missingFlow.status).toBe(400);
    expect(await missingFlow.json()).toEqual({ error: "INVALID_INPUT" });
    expect(statusPort).toHaveBeenCalledTimes(1);

    const get = await auth.handler(new Request("http://127.0.0.1:3000/api/auth/enterprise/status", {
      headers: { cookie, origin: "http://127.0.0.1:3000" },
    }));
    expect([404, 405]).toContain(get.status);
  });
});
