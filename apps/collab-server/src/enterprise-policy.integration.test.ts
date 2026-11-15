import { afterEach, describe, expect, it, vi } from "vitest";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import {
  assertCollabPolicyCompatible,
  createEnterprisePolicyBridge,
  EnterprisePolicyError,
  policyForCollabMode,
  type EnterprisePolicyBridge,
} from "./enterprise-policy";
import { authenticateCollabConnection } from "./auth";
import { createCollabServer } from "./server";

const SECRET = "fs65-ticket-secret";
const POLICY = {
  schema_version: 1 as const,
  effective_mode: "enterprise" as const,
  policy_epoch: 4,
  instance_id: "fs65",
  artifact_sha: "a".repeat(64),
};

function bridge(read: EnterprisePolicyBridge["read"] = async () => POLICY): EnterprisePolicyBridge {
  return { read };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("FS-65 collab authoritative policy bridge", () => {
  it("posts the strict policy operation with the independent Web service key", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:3000/api/internal/enterprise/eligibility");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fs65-service-key");
      expect(init?.body).toBe('{"op":"policy"}');
      return new Response(JSON.stringify(POLICY), { status: 200 });
    });
    const result = await createEnterprisePolicyBridge({
      webOrigin: "http://127.0.0.1:3000",
      serviceKey: "fs65-service-key",
      expectedInstanceId: "fs65",
      expectedArtifactSha: POLICY.artifact_sha,
      fetchImpl,
    }).read();
    expect(result).toEqual(POLICY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts identity/epoch qualification without accepting a non-boolean response", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ localUserId: "user", identityId: "identity", authEpoch: 4 }));
      return new Response(JSON.stringify({ eligible: true }), { status: 200 });
    });
    const bridge = createEnterprisePolicyBridge({
      webOrigin: "http://127.0.0.1:3000",
      serviceKey: "fs65-service-key",
      fetchImpl,
    });
    await expect(bridge.qualify!({ localUserId: "user", identityId: "identity", authEpoch: 4 })).resolves.toBe(true);

    const malformed = createEnterprisePolicyBridge({
      webOrigin: "http://127.0.0.1:3000",
      serviceKey: "fs65-service-key",
      fetchImpl: async () => new Response(JSON.stringify({ eligible: "yes" }), { status: 200 }),
    });
    await expect(malformed.qualify!({ localUserId: "user", identityId: "identity", authEpoch: 4 })).rejects.toBeInstanceOf(EnterprisePolicyError);
  });

  it("rejects malformed, stale, or unavailable Web policy without fallback", async () => {
    const unavailable = createEnterprisePolicyBridge({
      webOrigin: "http://127.0.0.1:3000",
      serviceKey: "fs65-service-key",
      fetchImpl: async () => new Response(JSON.stringify({ effective_mode: "enterprise" }), { status: 200 }),
    });
    await expect(unavailable.read()).rejects.toBeInstanceOf(EnterprisePolicyError);

    const stale = createEnterprisePolicyBridge({
      webOrigin: "http://127.0.0.1:3000",
      serviceKey: "fs65-service-key",
      expectedInstanceId: "other",
      fetchImpl: async () => new Response(JSON.stringify(POLICY), { status: 200 }),
    });
    await expect(stale.read()).rejects.toBeInstanceOf(EnterprisePolicyError);
  });

  it.each([
    ["legacy", "legacy", true],
    ["legacy", "enterprise", false],
    ["enterprise", "maintenance", true],
    ["enterprise", "enterprise", true],
    ["maintenance", "maintenance", true],
    ["maintenance", "enterprise", true],
  ] as const)("enforces local mode %s against Web mode %s", (local, effective, allowed) => {
    const policy = { ...POLICY, effective_mode: effective };
    if (allowed) expect(() => assertCollabPolicyCompatible(local, policy)).not.toThrow();
    else expect(() => assertCollabPolicyCompatible(local, policy)).toThrow(EnterprisePolicyError);
  });

  it("keeps a local maintenance process closed even when Web policy is enterprise", () => {
    expect(policyForCollabMode("maintenance", POLICY)).toMatchObject({
      effective_mode: "maintenance",
      policy_epoch: POLICY.policy_epoch,
    });
  });

  it("requires authoritative policy before startup and reports its epoch in health", async () => {
    vi.stubEnv("AUTH_MODE", "enterprise");
    const read = vi.fn(async () => POLICY);
    const handle = createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET, enterprisePolicy: bridge(read) });
    try {
      await handle.listen();
      const address = handle.server.address;
      const port = typeof address === "object" && address ? address.port : 0;
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ effective_mode: "enterprise", policy_epoch: 4 });
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await handle.destroy();
    }
  });

  it("refuses startup when policy is unavailable and DEV_ALLOW cannot bypass activation", async () => {
    vi.stubEnv("AUTH_MODE", "enterprise");
    vi.stubEnv("MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED", "1");
    const handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      enterprisePolicy: bridge(async () => { throw new EnterprisePolicyError(); }),
    });
    await expect(handle.listen()).rejects.toBeInstanceOf(EnterprisePolicyError);
    await handle.destroy();
  });

  it.each(["container:doc:fs65", "collection:channel:fs65"])("checks policy before %s ticket auth", async room => {
    const ticket = mintCollabTicket("user", SECRET, { roomName: room });
    await expect(authenticateCollabConnection({
      documentName: room,
      token: ticket,
      secret: SECRET,
      policy: { localMode: "legacy", policy: POLICY },
      resolveDocAccess: async () => ({ allow: true, readOnly: false, role: "owner", reason: "editor" }),
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
