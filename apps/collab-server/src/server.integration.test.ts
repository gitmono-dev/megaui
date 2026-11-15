/**
 * Integration: real Hocuspocus process + provider clients (CS-01 AC1–AC3).
 */
import { afterEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { createMapDocAccess } from "./auth";
import { createCollabServer, type CollabServerHandle } from "./server";

const SECRET = "integration-collab-secret";

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

describe("collab-server integration (CS-01)", () => {
  let handle: CollabServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.destroy();
      handle = null;
    }
  });

  it("syncs two editors with valid tickets and rejects bad tickets", async () => {
    handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      resolveDocAccess: createMapDocAccess({
        "doc-a": { allow: true, readOnly: false, role: "owner", reason: "editor" },
      }),
    });
    await handle.listen();
    const port = handle.port;
    // When port:0, Hocuspocus picks an ephemeral port — read from server address.
    const address = handle.server.address;
    const boundPort =
      typeof address === "object" && address && "port" in address
        ? (address as { port: number }).port
        : port;
    const wsUrl = `ws://127.0.0.1:${boundPort}`;

    const ticketA = mintCollabTicket("user-a", SECRET);
    const ticketB = mintCollabTicket("user-b", SECRET);
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    const providerA = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:doc-a",
      document: ydocA,
      token: ticketA,
    });
    const providerB = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:doc-a",
      document: ydocB,
      token: ticketB,
    });

    await waitFor(() => providerA.synced && providerB.synced);

    ydocA.getText("body").insert(0, "hello-collab");
    await waitFor(() => ydocB.getText("body").toString() === "hello-collab");

    providerA.destroy();
    providerB.destroy();

    // Bad ticket must fail to sync.
    const ydocBad = new Y.Doc();
    let authFailed = false;
    const providerBad = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:doc-a",
      document: ydocBad,
      token: "not-a-ticket",
      onAuthenticationFailed: () => {
        authFailed = true;
      },
    });
    await waitFor(() => authFailed, 3_000);
    providerBad.destroy();
  });

  it("sets read-only connections for viewer grants", async () => {
    handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      resolveDocAccess: async (docId, userId) => {
        if (userId === "viewer") {
          return { allow: true, readOnly: true, role: "member", reason: "read_only" };
        }
        return { allow: true, readOnly: false, role: "owner", reason: "editor" };
      },
    });
    await handle.listen();
    const address = handle.server.address;
    const boundPort =
      typeof address === "object" && address && "port" in address
        ? (address as { port: number }).port
        : handle.port;
    const wsUrl = `ws://127.0.0.1:${boundPort}`;

    const editorDoc = new Y.Doc();
    const viewerDoc = new Y.Doc();
    const editor = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:shared",
      document: editorDoc,
      token: mintCollabTicket("editor", SECRET),
    });
    const viewer = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:shared",
      document: viewerDoc,
      token: mintCollabTicket("viewer", SECRET),
    });

    await waitFor(() => editor.synced && viewer.synced);
    editorDoc.getText("body").insert(0, "from-editor");
    await waitFor(() => viewerDoc.getText("body").toString() === "from-editor");

    // Viewer write should not propagate (connection is read-only).
    viewerDoc.getText("body").insert(0, "from-viewer-");
    await new Promise((r) => setTimeout(r, 400));
    expect(editorDoc.getText("body").toString()).toBe("from-editor");

    editor.destroy();
    viewer.destroy();
  });

  it("enforces document limit and exposes health/reset", async () => {
    handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      maxDocuments: 1,
      resolveDocAccess: createMapDocAccess({
        d1: { allow: true, readOnly: false, role: "owner", reason: "editor" },
        d2: { allow: true, readOnly: false, role: "owner", reason: "editor" },
      }),
    });
    await handle.listen();
    const address = handle.server.address;
    const boundPort =
      typeof address === "object" && address && "port" in address
        ? (address as { port: number }).port
        : handle.port;
    const wsUrl = `ws://127.0.0.1:${boundPort}`;
    const httpBase = `http://127.0.0.1:${boundPort}`;

    const health = await fetch(`${httpBase}/health`);
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as { ok: boolean; service: string };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.service).toBe("megaui-collab");

    const y1 = new Y.Doc();
    const p1 = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:d1",
      document: y1,
      token: mintCollabTicket("u1", SECRET),
    });
    await waitFor(() => p1.synced);
    expect(handle.documentCount()).toBe(1);

    let secondFailed = false;
    const y2 = new Y.Doc();
    const p2 = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:d2",
      document: y2,
      token: mintCollabTicket("u2", SECRET),
      onAuthenticationFailed: () => {
        secondFailed = true;
      },
    });
    await waitFor(() => secondFailed, 3_000);
    p2.destroy();
    p1.destroy();

    const unauthorized = await fetch(`${httpBase}/internal/reset`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const reset = await fetch(`${httpBase}/internal/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(reset.status).toBe(200);
    await waitFor(() => handle!.documentCount() === 0, 3_000);
  });

  it("does not leak connectionCount after failed authentication", async () => {
    handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      maxConnections: 3,
      resolveDocAccess: createMapDocAccess({
        d1: { allow: true, readOnly: false, role: "owner", reason: "editor" },
      }),
    });
    await handle.listen();
    const address = handle.server.address;
    const boundPort =
      typeof address === "object" && address && "port" in address
        ? (address as { port: number }).port
        : handle.port;
    const wsUrl = `ws://127.0.0.1:${boundPort}`;

    expect(handle.connectionCount()).toBe(0);

    for (let i = 0; i < 5; i += 1) {
      let failed = false;
      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: wsUrl,
        name: "container:doc:d1",
        document: doc,
        token: "bogus-ticket",
        onAuthenticationFailed: () => {
          failed = true;
        },
      });
      await waitFor(() => failed, 3_000);
      provider.destroy();
    }

    await waitFor(() => handle!.connectionCount() === 0, 3_000);
    expect(handle.connectionCount()).toBe(0);

    // A valid connection still works after the failed flood.
    const okDoc = new Y.Doc();
    const ok = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:d1",
      document: okDoc,
      token: mintCollabTicket("ok-user", SECRET),
    });
    await waitFor(() => ok.synced);
    expect(handle.connectionCount()).toBe(1);
    ok.destroy();
    await waitFor(() => handle!.connectionCount() === 0, 3_000);
  });

  it("unloads a document after the last client disconnects", async () => {
    handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      resolveDocAccess: createMapDocAccess({
        idle: { allow: true, readOnly: false, role: "owner", reason: "editor" },
      }),
    });
    await handle.listen();
    const address = handle.server.address;
    const boundPort =
      typeof address === "object" && address && "port" in address
        ? (address as { port: number }).port
        : handle.port;
    const wsUrl = `ws://127.0.0.1:${boundPort}`;

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: "container:doc:idle",
      document: doc,
      token: mintCollabTicket("idle-user", SECRET),
    });
    await waitFor(() => provider.synced);
    expect(handle.documentCount()).toBe(1);
    provider.destroy();
    await waitFor(() => handle!.documentCount() === 0, 5_000);
  });

  it("admits a matching v2 channel ticket and rejects v1 even when DEV_ALLOW is on", async () => {
    const previous = process.env.MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED;
    process.env.MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED = "1";
    try {
      handle = createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET });
      await handle.listen();
      const address = handle.server.address;
      const boundPort =
        typeof address === "object" && address && "port" in address
          ? (address as { port: number }).port
          : handle.port;
      const wsUrl = `ws://127.0.0.1:${boundPort}`;
      const roomName = "collection:channel:live-1";

      let v1Failed = false;
      const v1Doc = new Y.Doc();
      const v1 = new HocuspocusProvider({
        url: wsUrl,
        name: roomName,
        document: v1Doc,
        token: mintCollabTicket("dev-user", SECRET),
        onAuthenticationFailed: () => {
          v1Failed = true;
        },
      });
      await waitFor(() => v1Failed, 3_000);
      v1.destroy();

      const ydoc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url: wsUrl,
        name: roomName,
        document: ydoc,
        token: mintCollabTicket("dev-user", SECRET, { roomName }),
      });
      await waitFor(() => provider.synced);
      expect(handle.connectionCount()).toBe(1);
      provider.destroy();
    } finally {
      if (previous === undefined) {
        delete process.env.MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED;
      } else {
        process.env.MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED = previous;
      }
    }
  });
});
