import type { AuthMode, EnterprisePolicyResponse } from "@megaui/core";

import { assertCollabPolicyCompatible, type EnterpriseEligibilityInput } from "./enterprise-policy.js";

export const COLLAB_REVALIDATION_INTERVAL_MS = 15_000;
export const COLLAB_REVALIDATION_MAX_REVOKE_LATENCY_MS = 30_000;

export interface RevalidationConnection {
  readonly userId: string;
  readonly identityId?: string;
  readonly authEpoch?: number;
  readonly close: () => void;
}

export interface EnterpriseRevalidatorOptions {
  readonly localMode: AuthMode;
  readonly readPolicy: () => Promise<EnterprisePolicyResponse>;
  readonly qualify?: (input: EnterpriseEligibilityInput) => Promise<boolean>;
  readonly listConnections: () => readonly RevalidationConnection[];
  readonly intervalMs?: number;
}

export interface EnterpriseRevalidator {
  readonly runOnce: () => Promise<{ closed: number }>;
  readonly start: () => void;
  readonly stop: () => void;
}

/**
 * Periodic qualification is authoritative for already-open sockets. A failed
 * policy/eligibility read closes only affected sockets; it never grants a
 * stale in-memory result as a fallback.
 */
export function createEnterpriseRevalidator(options: EnterpriseRevalidatorOptions): EnterpriseRevalidator {
  const intervalMs = options.intervalMs ?? COLLAB_REVALIDATION_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > COLLAB_REVALIDATION_MAX_REVOKE_LATENCY_MS) {
    throw new Error("Invalid collab revalidation interval");
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<{ closed: number }> | undefined;

  const runOnce = async (): Promise<{ closed: number }> => {
    if (inFlight) return inFlight;
    const work = (async () => {
      const connections = [...options.listConnections()];
      let policy: EnterprisePolicyResponse;
      try {
        policy = await options.readPolicy();
      } catch {
        for (const connection of connections) connection.close();
        return { closed: connections.length };
      }

      try {
        assertCollabPolicyCompatible(options.localMode, policy);
      } catch {
        for (const connection of connections) connection.close();
        return { closed: connections.length };
      }

      const qualify = options.qualify;
      const allowed = await Promise.all(connections.map(async (connection) => {
        if (options.localMode === "legacy") return true;
        if (!connection.identityId || connection.authEpoch === undefined ||
          connection.authEpoch !== policy.policy_epoch || !qualify) return false;
        try {
          return await qualify({
            localUserId: connection.userId,
            identityId: connection.identityId,
            authEpoch: connection.authEpoch,
          });
        } catch {
          return false;
        }
      }));
      let closed = 0;
      for (let index = 0; index < connections.length; index += 1) {
        if (allowed[index]) continue;
        const connection = connections[index];
        if (!connection) continue;
        connection.close();
        closed += 1;
      }
      return { closed };
    })();
    inFlight = work;
    try {
      return await work;
    } finally {
      if (inFlight === work) inFlight = undefined;
    }
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    timer.unref?.();
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  return Object.freeze({ runOnce, start, stop });
}
