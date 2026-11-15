import { describe, expect, it } from "vitest";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import {
  allowAuthenticatedEditor,
  authenticateCollabConnection,
  CollabAuthError,
  createMapDocAccess,
} from "./auth";

const SECRET = "test-collab-secret-cs01";

describe("authenticateCollabConnection (CS-01)", () => {
  it("accepts a valid ticket with editor access", async () => {
    const ticket = mintCollabTicket("user-1", SECRET, { nowMs: 1_000 });
    const context = await authenticateCollabConnection({
      documentName: "container:doc:d1",
      token: ticket,
      secret: SECRET,
      nowMs: 1_000,
      resolveDocAccess: createMapDocAccess({
        d1: { allow: true, readOnly: false, role: "owner", reason: "editor" },
      }),
    });
    expect(context.userId).toBe("user-1");
    expect(context.readOnly).toBe(false);
  });

  it("rejects missing / expired / wrong-secret tickets", async () => {
    await expect(
      authenticateCollabConnection({
        documentName: "container:doc:d1",
        token: "",
        secret: SECRET,
        resolveDocAccess: createMapDocAccess({
          d1: { allow: true, readOnly: false, role: "owner", reason: "editor" },
        }),
      }),
    ).rejects.toBeInstanceOf(CollabAuthError);

    const expired = mintCollabTicket("user-1", SECRET, { nowMs: 0, ttlMs: 1 });
    await expect(
      authenticateCollabConnection({
        documentName: "container:doc:d1",
        token: expired,
        secret: SECRET,
        nowMs: 10,
        resolveDocAccess: createMapDocAccess({
          d1: { allow: true, readOnly: false, role: "owner", reason: "editor" },
        }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const ticket = mintCollabTicket("user-1", SECRET, { nowMs: 0 });
    await expect(
      authenticateCollabConnection({
        documentName: "container:doc:d1",
        token: ticket,
        secret: "wrong",
        nowMs: 0,
        resolveDocAccess: createMapDocAccess({
          d1: { allow: true, readOnly: false, role: "owner", reason: "editor" },
        }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects when doc authz denies access", async () => {
    const ticket = mintCollabTicket("user-1", SECRET, { nowMs: 0 });
    await expect(
      authenticateCollabConnection({
        documentName: "container:doc:d1",
        token: ticket,
        secret: SECRET,
        nowMs: 0,
        resolveDocAccess: createMapDocAccess({}),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("marks read-only collaborators", async () => {
    const ticket = mintCollabTicket("viewer-1", SECRET, { nowMs: 0 });
    const context = await authenticateCollabConnection({
      documentName: "container:doc:d1",
      token: ticket,
      secret: SECRET,
      nowMs: 0,
      resolveDocAccess: createMapDocAccess({
        d1: { allow: true, readOnly: true, role: "member", reason: "read_only" },
      }),
    });
    expect(context.readOnly).toBe(true);
  });

  it("admits a matching v2 ticket to a channel room as read-only", async () => {
    const ticket = mintCollabTicket("user-1", SECRET, {
      nowMs: 0,
      roomName: "collection:channel:chn-1",
    });
    const context = await authenticateCollabConnection({
      documentName: "collection:channel:chn-1",
      token: ticket,
      secret: SECRET,
      nowMs: 0,
      resolveDocAccess: allowAuthenticatedEditor,
    });
    expect(context.userId).toBe("user-1");
    expect(context.readOnly).toBe(true);
    expect(context.room.kind).toBe("collection");
  });

  it("rejects v1 or mismatched v2 tickets on a channel room even with a permissive doc resolver", async () => {
    const v1 = mintCollabTicket("user-1", SECRET, { nowMs: 0 });
    await expect(
      authenticateCollabConnection({
        documentName: "collection:channel:chn-1",
        token: v1,
        secret: SECRET,
        nowMs: 0,
        resolveDocAccess: allowAuthenticatedEditor,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const otherRoom = mintCollabTicket("user-1", SECRET, {
      nowMs: 0,
      roomName: "collection:channel:other",
    });
    await expect(
      authenticateCollabConnection({
        documentName: "collection:channel:chn-1",
        token: otherRoom,
        secret: SECRET,
        nowMs: 0,
        resolveDocAccess: allowAuthenticatedEditor,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
