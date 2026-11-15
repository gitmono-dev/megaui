import { describe, expect, it, vi } from "vitest";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { authenticateCollabConnection } from "./auth";

const SECRET = "fs16-ticket-secret";
const POLICY = {
  schema_version: 1 as const,
  effective_mode: "enterprise" as const,
  policy_epoch: 4,
  instance_id: "fs16",
  artifact_sha: "a".repeat(64),
};

function enterpriseCheck(qualify: (input: { localUserId: string; identityId: string; authEpoch: number }) => Promise<boolean>) {
  return { localMode: "enterprise" as const, policy: POLICY, qualify };
}

describe("FS-16 enterprise collab v3 tickets", () => {
  it.each(["v1", "v2"] as const)("rejects %s tickets before room authorization", async version => {
    const token = version === "v1"
      ? mintCollabTicket("user", SECRET, { nowMs: 0 })
      : mintCollabTicket("user", SECRET, { nowMs: 0, roomName: "collection:channel:fs16" });
    const qualify = vi.fn(async () => true);
    await expect(authenticateCollabConnection({
      documentName: version === "v1" ? "container:doc:fs16" : "collection:channel:fs16",
      token,
      secret: SECRET,
      nowMs: 0,
      policy: enterpriseCheck(qualify),
      resolveDocAccess: async () => ({ allow: true, readOnly: false, role: "owner", reason: "editor" }),
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(qualify).not.toHaveBeenCalled();
  });

  it("checks the current identity/epoch before allowing a document room", async () => {
    const order: string[] = [];
    const qualify = vi.fn(async (input: { localUserId: string; identityId: string; authEpoch: number }) => {
      order.push(`qualify:${input.localUserId}:${input.identityId}:${input.authEpoch}`);
      return true;
    });
    const access = vi.fn(async () => {
      order.push("access");
      return { allow: true, readOnly: false, role: "owner", reason: "editor" as const };
    });
    const token = mintCollabTicket("user", SECRET, {
      nowMs: 0,
      identityId: "identity",
      authEpoch: 4,
    });
    await expect(authenticateCollabConnection({
      documentName: "container:doc:fs16",
      token,
      secret: SECRET,
      nowMs: 0,
      policy: enterpriseCheck(qualify),
      resolveDocAccess: access,
    })).resolves.toMatchObject({ userId: "user", room: { kind: "container" } });
    expect(order).toEqual(["qualify:user:identity:4", "access"]);
  });

  it("checks the current identity/epoch before allowing a collection room", async () => {
    const qualify = vi.fn(async () => true);
    const token = mintCollabTicket("user", SECRET, {
      nowMs: 0,
      identityId: "identity",
      authEpoch: 4,
      roomName: "collection:channel:fs16",
    });
    await expect(authenticateCollabConnection({
      documentName: "collection:channel:fs16",
      token,
      secret: SECRET,
      nowMs: 0,
      policy: enterpriseCheck(qualify),
    })).resolves.toMatchObject({ userId: "user", room: { kind: "collection" }, readOnly: true });
    expect(qualify).toHaveBeenCalledWith({ localUserId: "user", identityId: "identity", authEpoch: 4 });
  });

  it("rejects an epoch-stale ticket and a collection room mismatch", async () => {
    const qualify = vi.fn(async () => true);
    const stale = mintCollabTicket("user", SECRET, { nowMs: 0, identityId: "identity", authEpoch: 3 });
    await expect(authenticateCollabConnection({
      documentName: "container:doc:fs16", token: stale, secret: SECRET, nowMs: 0,
      policy: enterpriseCheck(qualify),
      resolveDocAccess: async () => ({ allow: true, readOnly: false, role: "owner", reason: "editor" }),
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(qualify).not.toHaveBeenCalled();

    const mismatched = mintCollabTicket("user", SECRET, {
      nowMs: 0, identityId: "identity", authEpoch: 4, roomName: "collection:channel:other",
    });
    await expect(authenticateCollabConnection({
      documentName: "collection:channel:fs16", token: mismatched, secret: SECRET, nowMs: 0,
      policy: enterpriseCheck(qualify),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(qualify).toHaveBeenCalledTimes(1);
  });

  it("fails closed when qualification is unavailable or false", async () => {
    const token = mintCollabTicket("user", SECRET, { nowMs: 0, identityId: "identity", authEpoch: 4 });
    await expect(authenticateCollabConnection({
      documentName: "container:doc:fs16", token, secret: SECRET, nowMs: 0,
      policy: enterpriseCheck(async () => { throw new Error("offline"); }),
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(authenticateCollabConnection({
      documentName: "container:doc:fs16", token, secret: SECRET, nowMs: 0,
      policy: enterpriseCheck(async () => false),
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
