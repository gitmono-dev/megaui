import { describe, expect, it, vi } from "vitest";

import { CollabRevokeError, createEnterpriseCollabRevokeService } from "./collab-revoke";
import {
  ENTERPRISE_COLLAB_REVOKE_QUEUE,
  parseEnterpriseCollabRevokeJobPayload,
  scheduleEnterpriseCollabRevokeJob,
} from "./jobs";

describe("enterprise collab revoke bridge", () => {
  it("fans out to every target with the independent bearer and strict payload", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/internal\/revoke$/u);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer revoke-key");
      expect(init?.body).toBe(JSON.stringify({ userId: "user-1", authEpoch: 4 }));
      return new Response(JSON.stringify({ data: { revoked: true, closed: 1 } }), { status: 200 });
    });
    const service = createEnterpriseCollabRevokeService({
      targets: [
        { url: "http://collab-a:7002", token: "revoke-key" },
        { url: "http://collab-b:7002/", token: "revoke-key" },
      ],
      fetchImpl,
    });
    await expect(service.revokeUser("user-1", 4)).resolves.toEqual({ delivered: 2, closed: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never falls back to the ticket secret and fails closed on a bad response", async () => {
    expect(() => createEnterpriseCollabRevokeService({
      targets: [{ url: "http://collab:7002", token: "" }],
    })).toThrow(CollabRevokeError);
    const service = createEnterpriseCollabRevokeService({
      targets: [{ url: "http://collab:7002", token: "revoke-key" }],
      fetchImpl: async () => new Response(JSON.stringify({ data: { revoked: false, closed: 0 } }), { status: 200 }),
    });
    await expect(service.revokeUser("user-1", 4)).rejects.toBeInstanceOf(CollabRevokeError);
  });

  it("keeps revoke jobs strict, secret-free, and idempotent", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const writer = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rowCount: queries.length === 1 ? 1 : 0 };
      },
    };
    const payload = { userId: "user-1", authEpoch: 4, reason: "directory-offboarding" };
    expect(parseEnterpriseCollabRevokeJobPayload(payload)).toEqual(payload);
    expect(() => parseEnterpriseCollabRevokeJobPayload({ ...payload, token: "secret" })).toThrow();
    await expect(scheduleEnterpriseCollabRevokeJob(writer, payload)).resolves.toBe(true);
    await expect(scheduleEnterpriseCollabRevokeJob(writer, payload)).resolves.toBe(false);
    const firstQuery = queries[0];
    expect(firstQuery).toBeDefined();
    expect(firstQuery?.values).toEqual(expect.arrayContaining([
      ENTERPRISE_COLLAB_REVOKE_QUEUE,
      JSON.stringify(payload),
    ]));
    expect(JSON.stringify(queries)).not.toContain("ticket");
  });
});
