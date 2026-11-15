import { describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { createEnterpriseRevalidator } from "./enterprise-revalidation";
import { createCollabServer } from "./server";

const SECRET = "fs17-ticket-secret";
const REVOKE_KEY = "fs17-independent-revoke-key";
const POLICY = {
  schema_version: 1 as const,
  effective_mode: "enterprise" as const,
  policy_epoch: 4,
  instance_id: "fs17",
  artifact_sha: "a".repeat(64),
};

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("FS-17 enterprise collab revalidation and revoke", () => {
  it("revalidates every mode and closes only stale or unavailable connections", async () => {
    const closed: string[] = [];
    let policy: typeof POLICY | null = POLICY;
    const qualify = vi.fn(async (input: { localUserId: string; identityId: string; authEpoch: number }) => input.localUserId !== "revoked");
    const revalidator = createEnterpriseRevalidator({
      localMode: "enterprise",
      readPolicy: async () => {
        if (!policy) throw new Error("offline");
        return policy;
      },
      qualify,
      listConnections: () => [
        { userId: "ok", identityId: "identity-ok", authEpoch: 4, close: () => closed.push("ok") },
        { userId: "revoked", identityId: "identity-revoked", authEpoch: 4, close: () => closed.push("revoked") },
        { userId: "stale", identityId: "identity-stale", authEpoch: 3, close: () => closed.push("stale") },
      ],
      intervalMs: 15_000,
    });
    await expect(revalidator.runOnce()).resolves.toEqual({ closed: 2 });
    expect(closed).toEqual(["revoked", "stale"]);
    policy = null;
    await expect(revalidator.runOnce()).resolves.toEqual({ closed: 3 });
  });

  it("starts a bounded periodic revalidation loop", async () => {
    const closed: string[] = [];
    const qualify = vi.fn(async () => false);
    const revalidator = createEnterpriseRevalidator({
      localMode: "enterprise",
      readPolicy: async () => POLICY,
      qualify,
      intervalMs: 10,
      listConnections: () => [{
        userId: "user-1",
        identityId: "identity-1",
        authEpoch: POLICY.policy_epoch,
        close: () => closed.push("user-1"),
      }],
    });
    revalidator.start();
    try {
      await waitFor(() => qualify.mock.calls.length > 0);
      expect(closed).toContain("user-1");
    } finally {
      revalidator.stop();
    }
  });

  it("closes a revoked user on every instance without using the ticket secret", async () => {
    const handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      revokeToken: REVOKE_KEY,
    });
    await handle.listen();
    try {
      const address = handle.server.address;
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/internal/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${REVOKE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1", authEpoch: 4 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { revoked: true, closed: 0 } });

      const wrong = await fetch(`http://127.0.0.1:${port}/internal/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1", authEpoch: 4 }),
      });
      expect(wrong.status).toBe(401);
    } finally {
      await handle.destroy();
    }
  });

  it("closes only the revoked user's existing connection", async () => {
    const handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      revokeToken: REVOKE_KEY,
      resolveDocAccess: async () => ({ allow: true, readOnly: false, role: "owner", reason: "editor" }),
    });
    await handle.listen();
    const address = handle.server.address;
    const port = typeof address === "object" && address ? address.port : 0;
    const closed: string[] = [];
    const connected: string[] = [];
    const providerA = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: "container:doc:fs17",
      document: new Y.Doc(),
      token: mintCollabTicket("user-a", SECRET),
      onStatus: ({ status }) => {
        if (status === "connected") connected.push("user-a");
        if (status === "disconnected") closed.push("user-a");
      },
    });
    const providerB = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: "container:doc:fs17",
      document: new Y.Doc(),
      token: mintCollabTicket("user-b", SECRET),
      onStatus: ({ status }) => {
        if (status === "connected") connected.push("user-b");
        if (status === "disconnected") closed.push("user-b");
      },
    });
    try {
      await waitFor(() => connected.includes("user-a") && connected.includes("user-b"));
      const response = await fetch(`http://127.0.0.1:${port}/internal/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${REVOKE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-a", authEpoch: 4 }),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ data: { revoked: true, closed: 1 } });
      await waitFor(() => handle.connectionCount() === 1);
      expect(closed).not.toContain("user-b");
    } finally {
      providerA.destroy();
      providerB.destroy();
      await handle.destroy();
    }
  });

});
