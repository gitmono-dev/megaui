/**
 * Hocuspocus collab server factory (CS-01).
 */

import { Server, type Hocuspocus } from "@hocuspocus/server";

import {
  allowAuthenticatedEditor,
  authenticateCollabConnection,
  CollabAuthError,
  denyAllDocAccess,
  isFeishuCollabMode,
  type CollabAuthContext,
  type ResolveDocAccess,
} from "./auth.js";
import { handleInternalRequest } from "./internal-api.js";

export interface CollabServerOptions {
  port?: number;
  quiet?: boolean;
  debounce?: number;
  maxDebounce?: number;
  resolveDocAccess?: ResolveDocAccess;
  /** Override ticket secret (tests). */
  ticketSecret?: string;
  maxDocuments?: number;
  maxConnections?: number;
}

export interface CollabServerHandle {
  server: Server;
  hocuspocus: Hocuspocus;
  port: number;
  listen: () => Promise<void>;
  destroy: () => Promise<void>;
  /** Live document count (GC-09). */
  documentCount: () => number;
  /** Live connection count across documents. */
  connectionCount: () => number;
}

function resolvePort(explicit?: number): number {
  if (explicit != null) return explicit;
  const fromEnv = Number(process.env.MEGA_COLLAB_PORT ?? process.env.PORT ?? 7002);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 7002;
}

function resolveDebounce(explicit?: number): number {
  if (explicit != null) return explicit;
  const fromEnv = Number(process.env.MEGA_COLLAB_STORE_DEBOUNCE_MS ?? 2000);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2000;
}

function resolveLimit(envName: string, fallback: number, explicit?: number): number {
  if (explicit != null) return explicit;
  const fromEnv = Number(process.env[envName] ?? fallback);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : fallback;
}

function resolveDefaultAuthz(explicit?: ResolveDocAccess): ResolveDocAccess {
  if (explicit) return explicit;
  if (process.env.MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED === "1") {
    return allowAuthenticatedEditor;
  }
  return denyAllDocAccess;
}

export function createCollabServer(options: CollabServerOptions = {}): CollabServerHandle {
  const port = resolvePort(options.port);
  const debounce = resolveDebounce(options.debounce);
  const maxDebounce = options.maxDebounce ?? Math.max(debounce * 5, 10_000);
  const maxDocuments = resolveLimit("MEGA_COLLAB_MAX_DOCUMENTS", 512, options.maxDocuments);
  const maxConnections = resolveLimit(
    "MEGA_COLLAB_MAX_CONNECTIONS",
    1024,
    options.maxConnections,
  );
  const resolveDocAccess = resolveDefaultAuthz(options.resolveDocAccess);
  const ticketSecret = options.ticketSecret;
  // FSL-134: the mode is resolved once, here, by the shared rule set
  // (`resolveAuthMode` via `isFeishuCollabMode`). A pair it refuses throws its
  // `AuthModeError`, so the server is never built. Feishu and legacy then check
  // every connection the same way: an ordinary collab ticket, no enterprise
  // metadata, no policy reads.
  const feishuMode = isFeishuCollabMode({
    AUTH_MODE: process.env.AUTH_MODE,
    AUTH_PROVIDER: process.env.AUTH_PROVIDER,
  });

  let hocuspocusRef: Hocuspocus | null = null;
  let connectionTotal = 0;

  const documentCount = (): number => hocuspocusRef?.documents.size ?? 0;
  const connectionCount = (): number => connectionTotal;

  const server = new Server<CollabAuthContext>({
    name: "megaui-collab",
    port,
    address: process.env.MEGA_COLLAB_BIND?.trim() || "127.0.0.1",
    quiet: options.quiet ?? process.env.MEGA_COLLAB_QUIET === "1",
    stopOnSignals: false,
    debounce,
    maxDebounce,
    unloadImmediately: true,
    timeout: 60_000,
    async onAuthenticate(data) {
      try {
        if (connectionTotal >= maxConnections) {
          throw new Error("Collab connection limit reached");
        }
        if (documentCount() >= maxDocuments && !hocuspocusRef?.documents.has(data.documentName)) {
          throw new Error("Collab document limit reached");
        }
        const context = await authenticateCollabConnection({
          documentName: data.documentName,
          token: data.token,
          secret: ticketSecret,
          resolveDocAccess,
        });
        if (context.readOnly) {
          data.connectionConfig.readOnly = true;
        }
        // Count only after successful auth — Hocuspocus does not call
        // onDisconnect when onAuthenticate throws (failed auth leak).
        connectionTotal += 1;
        return context;
      } catch (error) {
        if (error instanceof CollabAuthError) {
          // Rewrap as a generic Error for the Hocuspocus boundary, but keep
          // the original as `cause` (ER-10 error contract / lint rule).
          throw new Error(error.message, { cause: error });
        }
        throw error;
      }
    },
    async onDisconnect() {
      connectionTotal = Math.max(0, connectionTotal - 1);
    },
    async onRequest({ request, response }) {
      const handled = await handleInternalRequest(request, response, {
        getToken: () => ticketSecret ?? process.env.MEGA_COLLAB_INTERNAL_TOKEN,
        getHocuspocus: () => {
          if (!hocuspocusRef) throw new Error("Hocuspocus not ready");
          return hocuspocusRef;
        },
        getStats: () => ({
          documents: documentCount(),
          connections: connectionCount(),
        }),
      });
      if (handled) {
        return Promise.reject();
      }
    },
  });

  hocuspocusRef = server.hocuspocus;

  let shuttingDown = false;

  const destroy = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.destroy();
  };

  const listen = async (): Promise<void> => {
    await server.listen();
    console.log(
      `[collab-server] listening on ${port} (mode=${feishuMode ? "feishu" : "legacy"} debounce=${debounce}ms maxDocs=${maxDocuments} maxConn=${maxConnections})`,
    );
  };

  return {
    server,
    hocuspocus: server.hocuspocus,
    port,
    listen,
    destroy,
    documentCount,
    connectionCount,
  };
}
