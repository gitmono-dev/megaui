import { afterEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { createCollabServer, type CollabServerHandle } from "./server";

const SECRET = "internal-api-collab-secret";

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function boundHttpBase(handle: CollabServerHandle): { httpBase: string; wsUrl: string } {
  const address = handle.server.address;
  const boundPort =
    typeof address === "object" && address && "port" in address
      ? (address as { port: number }).port
      : handle.port;
  return {
    httpBase: `http://127.0.0.1:${boundPort}`,
    wsUrl: `ws://127.0.0.1:${boundPort}`,
  };
}

describe("internal collection append/bump (RT-06)", () => {
  let handle: CollabServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.destroy();
      handle = null;
    }
  });

  it("updates a channel Y.Doc with a valid bearer and rejects missing/wrong tokens", async () => {
    handle = createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET });
    await handle.listen();
    const { httpBase, wsUrl } = boundHttpBase(handle);
    const roomName = "collection:channel:chn-1";

    const unauthorized = await fetch(`${httpBase}/internal/collection/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, childId: "msg-1" }),
    });
    expect(unauthorized.status).toBe(401);
    expect(JSON.stringify(await unauthorized.json())).not.toMatch(/mega-collab|msg-1 body/);

    const wrong = await fetch(`${httpBase}/internal/collection/append`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName, childId: "msg-1" }),
    });
    expect(wrong.status).toBe(401);

    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: roomName,
      document: ydoc,
      token: mintCollabTicket("member-1", SECRET, { roomName }),
    });
    await waitFor(() => provider.synced);

    const append = await fetch(`${httpBase}/internal/collection/append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName, childId: "msg-1" }),
    });
    expect(append.status).toBe(200);
    const appendBody = (await append.json()) as { data?: { appended?: boolean } };
    expect(appendBody.data?.appended).toBe(true);
    expect(JSON.stringify(appendBody)).not.toMatch(/mega-collab\.v2/);

    await waitFor(() => ydoc.getArray<string>("childIds").toArray().includes("msg-1"));

    const again = await fetch(`${httpBase}/internal/collection/append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName, childId: "msg-1" }),
    });
    expect(again.status).toBe(200);
    expect(ydoc.getArray<string>("childIds").toArray()).toEqual(["msg-1"]);

    const bump = await fetch(`${httpBase}/internal/collection/bump`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName, kind: "reaction", messageId: "msg-1", at: 42 }),
    });
    expect(bump.status).toBe(200);
    await waitFor(() => ydoc.getMap("revision").get("kind") === "reaction");
    expect(ydoc.getMap("revision").get("messageId")).toBe("msg-1");

    provider.destroy();
  });

  it("rejects inbox/doc collection rooms and empty ids", async () => {
    handle = createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET });
    await handle.listen();
    const { httpBase } = boundHttpBase(handle);

    const inbox = await fetch(`${httpBase}/internal/collection/append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName: "collection:inbox:user-1", childId: "msg-1" }),
    });
    expect(inbox.status).toBe(400);

    const empty = await fetch(`${httpBase}/internal/collection/append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomName: "collection:channel:chn-1", childId: "" }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("FSL-134: the user-revocation endpoint is removed", () => {
  let handle: CollabServerHandle | null = null;
  const REVOKE_KEY = "fsl134-old-revoke-key";

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (handle) {
      await handle.destroy();
      handle = null;
    }
  });

  it("AC3: POST /internal/revoke returns 404 and closes no connection", async () => {
    // A leftover revocation key in the environment grants nothing.
    vi.stubEnv("ENTERPRISE_COLLAB_REVOKE_KEY", REVOKE_KEY);
    handle = createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET });
    await handle.listen();
    const { httpBase, wsUrl } = boundHttpBase(handle);
    const roomName = "collection:channel:fsl134";

    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: roomName,
      document: new Y.Doc(),
      token: mintCollabTicket("member-1", SECRET, { roomName }),
    });
    await waitFor(() => provider.synced);
    expect(handle.connectionCount()).toBe(1);

    const body = JSON.stringify({ userId: "member-1", authEpoch: 1 });
    // Whatever the caller presents (no bearer, the internal token, the old
    // revocation key, a wrong token) and whatever the method, the path is 404.
    const attempts: Array<[string, Record<string, string>]> = [
      ["POST", {}],
      ["POST", { Authorization: `Bearer ${SECRET}` }],
      ["POST", { Authorization: `Bearer ${REVOKE_KEY}` }],
      ["POST", { Authorization: "Bearer wrong-token" }],
      ["GET", { Authorization: `Bearer ${SECRET}` }],
    ];
    for (const [method, auth] of attempts) {
      const revoke = await fetch(`${httpBase}/internal/revoke`, {
        method,
        headers: { ...auth, "Content-Type": "application/json" },
        ...(method === "POST" ? { body } : {}),
      });
      expect(revoke.status, `${method} ${Object.keys(auth).join()}`).toBe(404);
      expect(await revoke.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Unknown internal path: /internal/revoke" },
      });
    }

    // The existing internal routes still require the internal token.
    const unauthorized = await fetch(`${httpBase}/internal/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REVOKE_KEY}` },
    });
    expect(unauthorized.status).toBe(401);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.synced).toBe(true);
    expect(handle.connectionCount()).toBe(1);
    provider.destroy();
  });
});
