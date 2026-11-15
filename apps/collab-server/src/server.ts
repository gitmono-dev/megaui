/**
 * Hocuspocus collab server factory (CS-01).
 */

import { Server, type Hocuspocus } from "@hocuspocus/server";
import type { EnterprisePolicyResponse } from "@megaui/core";

import {
  allowAuthenticatedEditor,
  authenticateCollabConnection,
  CollabAuthError,
  denyAllDocAccess,
  type CollabAuthContext,
  type ResolveDocAccess,
} from "./auth.js";
import {
  bridgeFromEnvironment,
  policyForCollabMode,
  resolveCollabAuthMode,
  type EnterprisePolicyBridge,
} from "./enterprise-policy.js";
import { createEnterpriseRevalidator, type RevalidationConnection } from "./enterprise-revalidation.js";
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
  /** Override the Web policy bridge in tests or an explicitly wired host. */
  enterprisePolicy?: EnterprisePolicyBridge;
  /** Independent credential for the internal user-revoke endpoint. */
  revokeToken?: string;
  /** Test-only clock interval override; production remains 15 seconds. */
  revalidationIntervalMs?: number;
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
  const localMode = resolveCollabAuthMode();
  const policyBridge = options.enterprisePolicy ?? bridgeFromEnvironment();

  const readPolicy = async (): Promise<EnterprisePolicyResponse | null> => {
    if (!policyBridge) return null;
    const policy = await policyBridge.read();
    return policyForCollabMode(localMode, policy);
  };

  let hocuspocusRef: Hocuspocus | null = null;
  let connectionTotal = 0;
  const revokedEpochs = new Map<string, number>();

  const documentCount = (): number => hocuspocusRef?.documents.size ?? 0;
  const connectionCount = (): number => connectionTotal;

  const listConnections = (): readonly RevalidationConnection[] => {
    if (!hocuspocusRef) return [];
    const connections: RevalidationConnection[] = [];
    for (const document of hocuspocusRef.documents.values()) {
      for (const connection of document.getConnections()) {
        const context = connection.context as CollabAuthContext;
        connections.push({
          userId: context.userId,
          ...(context.identityId ? { identityId: context.identityId, authEpoch: context.authEpoch } : {}),
          close: () => connection.close(),
        });
      }
    }
    return connections;
  };

  const revokeUser = (userId: string, authEpoch: number): number => {
    const previous = revokedEpochs.get(userId);
    if (previous !== undefined && previous >= authEpoch) return 0;
    revokedEpochs.set(userId, authEpoch);
    let closed = 0;
    for (const connection of listConnections()) {
      if (connection.userId !== userId ||
        (connection.authEpoch !== undefined && connection.authEpoch > authEpoch)) continue;
      connection.close();
      closed += 1;
    }
    return closed;
  };

  const revalidator = policyBridge ? createEnterpriseRevalidator({
    localMode,
    readPolicy: async () => {
      const policy = await readPolicy();
      if (!policy) throw new Error("ENTERPRISE_POLICY_UNAVAILABLE");
      return policy;
    },
    qualify: policyBridge.qualify,
    listConnections,
    intervalMs: options.revalidationIntervalMs,
  }) : undefined;

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
        const policy = await readPolicy();
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
          ...(policy ? {
            policy: {
              localMode,
              policy,
              ...(policyBridge?.qualify ? { qualify: policyBridge.qualify } : {}),
            },
          } : {}),
        });
        const revokedEpoch = revokedEpochs.get(context.userId);
        if (revokedEpoch !== undefined &&
          (context.authEpoch === undefined || context.authEpoch <= revokedEpoch)) {
          throw new Error("Collab user has been revoked");
        }
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
        getRevokeToken: () => options.revokeToken ?? process.env.ENTERPRISE_COLLAB_REVOKE_KEY,
        getHocuspocus: () => {
          if (!hocuspocusRef) throw new Error("Hocuspocus not ready");
          return hocuspocusRef;
        },
        getStats: () => ({
          documents: documentCount(),
          connections: connectionCount(),
        }),
        getPolicy: policyBridge ? readPolicy : undefined,
        revokeUser,
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
    revalidator?.stop();
    await server.destroy();
  };

  const listen = async (): Promise<void> => {
    if (policyBridge) await readPolicy();
    await server.listen();
    revalidator?.start();
    console.log(
      `[collab-server] listening on ${port} (debounce=${debounce}ms maxDocs=${maxDocuments} maxConn=${maxConnections})`,
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
