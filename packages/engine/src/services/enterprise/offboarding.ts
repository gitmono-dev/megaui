// megaui-only (FS-18): enterprise identity offboarding orchestration.
import type { Pool } from "pg";

import {
  createEnterpriseOffboardingStore,
  EnterpriseOffboardingError,
  type EnterpriseOffboardingInput,
  type EnterpriseOffboardingResult,
  type EnterpriseOffboardingStore,
} from "@megaui/database";

export interface EnterpriseOffboardingServiceOptions {
  readonly pool: Pool;
  readonly store?: EnterpriseOffboardingStore;
}

export interface EnterpriseOffboardingService {
  readonly offboard: (input: EnterpriseOffboardingInput) => Promise<EnterpriseOffboardingResult>;
}

/**
 * Builds the sole engine entry point for directory resignation and local
 * quarantine. The database store owns one READ COMMITTED transaction: identity
 * status/version, policy epoch, challenge/grant/session invalidation, and the
 * per-user revoke outbox either all commit or all roll back.
 */
export function createEnterpriseOffboardingService(
  options: EnterpriseOffboardingServiceOptions,
): EnterpriseOffboardingService {
  if (!options || !options.pool || typeof options.pool.connect !== "function") {
    throw new Error("INVALID_ENTERPRISE_OFFBOARDING_CONFIG");
  }
  const store = options.store ?? createEnterpriseOffboardingStore(options.pool);
  return Object.freeze({ offboard: (input: EnterpriseOffboardingInput) => store.offboard(input) });
}

/** Convenience port for callers that already own the database pool. */
export async function offboardEnterpriseUser(
  pool: Pool,
  input: EnterpriseOffboardingInput,
): Promise<EnterpriseOffboardingResult> {
  return createEnterpriseOffboardingService({ pool }).offboard(input);
}

export type { EnterpriseOffboardingInput, EnterpriseOffboardingResult, EnterpriseOffboardingStore };
export { EnterpriseOffboardingError };
