/**
 * Internal HTTP endpoints for web ↔ collab-server (shared secret).
 * Timing-safe token compare (GC-07).
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hocuspocus } from "@hocuspocus/server";
import { COLLECTION_CHILD_IDS_KEY, COLLECTION_REVISION_KEY } from "@megaui/core";

import { parseRoomName } from "./rooms.js";

export interface InternalApiOptions {
  getToken: () => string | undefined;
  getHocuspocus: () => Hocuspocus;
  getStats?: () => { documents: number; connections: number };
}

/** The internal routes; each needs the internal bearer token. */
const INTERNAL_POST_PATHS: ReadonlySet<string> = new Set([
  "/internal/reset",
  "/internal/collection/append",
  "/internal/collection/bump",
]);

function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function timingSafeTokenEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length, 0));
    return false;
  }
  return timingSafeEqual(a, b);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += bytes.byteLength;
    if (size > maxBytes) return null;
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function requireInternalAuth(
  request: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return false;
  const header = request.headers.authorization;
  const provided = readBearer(typeof header === "string" ? header : undefined);
  if (!provided) return false;
  return timingSafeTokenEqual(expectedToken, provided);
}

/**
 * Handle /internal/* and /health on the Hocuspocus HTTP port.
 * Returns true when the request was handled (caller should stop the chain).
 */
export async function handleInternalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: InternalApiOptions,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (request.method === "GET" && (path === "/health" || path === "/internal/health")) {
    const stats = options.getStats?.() ?? { documents: 0, connections: 0 };
    sendJson(response, 200, {
      ok: true,
      service: "megaui-collab",
      documents: stats.documents,
      connections: stats.connections,
    });
    return true;
  }

  if (!path.startsWith("/internal/")) {
    return false;
  }

  // FSL-134: only the routes below exist (there is no user-revocation
  // endpoint). Any other method and path is 404 for every caller, with or
  // without a token; every existing route still needs the internal token.
  if (request.method !== "POST" || !INTERNAL_POST_PATHS.has(path)) {
    sendJson(response, 404, {
      error: { code: "NOT_FOUND", message: `Unknown internal path: ${path}` },
    });
    return true;
  }

  const expected = options.getToken();
  if (!requireInternalAuth(request, expected)) {
    sendJson(response, 401, {
      error: { code: "UNAUTHORIZED", message: "Invalid internal token" },
    });
    return true;
  }

  const hocuspocus = options.getHocuspocus();

  if (request.method === "POST" && path === "/internal/reset") {
    const names = [...hocuspocus.documents.keys()];
    hocuspocus.closeConnections();
    hocuspocus.flushPendingStores();

    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      let busy = false;
      for (const document of hocuspocus.documents.values()) {
        if (document.getConnectionsCount() > 0) {
          busy = true;
          break;
        }
      }
      if (!busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    for (const name of [...hocuspocus.documents.keys()]) {
      const document = hocuspocus.documents.get(name);
      if (!document) continue;
      await hocuspocus.unloadDocument(document);
      if (hocuspocus.documents.has(name)) {
        hocuspocus.documents.delete(name);
        try {
          document.destroy();
        } catch {
          // already destroyed
        }
      }
    }
    sendJson(response, 200, {
      data: {
        reset: true,
        unloaded: names.length,
        remaining: hocuspocus.documents.size,
      },
    });
    return true;
  }

  if (
    request.method === "POST" &&
    (path === "/internal/collection/append" || path === "/internal/collection/bump")
  ) {
    const body = await readJsonBody(request);
    if (body === null) {
      sendJson(response, 400, {
        error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
      });
      return true;
    }
    const record = asRecord(body);
    const roomName = typeof record?.roomName === "string" ? record.roomName.trim() : "";
    const room = parseRoomName(roomName);
    if (!room || room.kind !== "collection") {
      sendJson(response, 400, {
        error: { code: "BAD_REQUEST", message: "Unsupported collection room" },
      });
      return true;
    }

    if (path === "/internal/collection/append") {
      const childId = typeof record?.childId === "string" ? record.childId.trim() : "";
      if (!childId) {
        sendJson(response, 400, {
          error: { code: "BAD_REQUEST", message: "childId is required" },
        });
        return true;
      }
      const connection = await hocuspocus.openDirectConnection(room.documentName, {
        internal: true,
      });
      try {
        await connection.transact((document) => {
          const childIds = document.getArray<string>(COLLECTION_CHILD_IDS_KEY);
          if (!childIds.toArray().includes(childId)) {
            childIds.push([childId]);
          }
        });
      } finally {
        await connection.disconnect();
      }
      sendJson(response, 200, { data: { appended: true, roomName: room.documentName } });
      return true;
    }

    const kind = typeof record?.kind === "string" ? record.kind.trim() : "";
    const messageId = typeof record?.messageId === "string" ? record.messageId.trim() : "";
    const at = typeof record?.at === "number" ? record.at : Date.now();
    if (!kind || !messageId) {
      sendJson(response, 400, {
        error: { code: "BAD_REQUEST", message: "kind and messageId are required" },
      });
      return true;
    }
    const connection = await hocuspocus.openDirectConnection(room.documentName, {
      internal: true,
    });
    try {
      await connection.transact((document) => {
        const revision = document.getMap(COLLECTION_REVISION_KEY);
        revision.set("kind", kind);
        revision.set("messageId", messageId);
        revision.set("at", at);
      });
    } finally {
      await connection.disconnect();
    }
    sendJson(response, 200, { data: { bumped: true, roomName: room.documentName } });
    return true;
  }

  sendJson(response, 404, {
    error: { code: "NOT_FOUND", message: `Unknown internal path: ${path}` },
  });
  return true;
}
