// megaui-only (FS-11): trusted application port; raw HTTP aliases belong to auth's sole parser.
import { createAnonymousPairingBudget } from "./anonymous-budget";
import type { AnonymousPairingBudgetOptions, AnonymousTransport } from "./anonymous-budget-types";
import { insertPendingPairing } from "./pairing-store";

export interface EnterprisePairingServiceOptions extends AnonymousPairingBudgetOptions {
  readonly tenantKey: string;
  readonly appId: string;
}

export interface EnterprisePairingRequest {
  /** Already admitted by the auth alias boundary; this service does not duplicate that grammar. */
  readonly loginName: string;
  readonly flowHash: string;
  readonly transport: AnonymousTransport;
}

export type EnterprisePairingResult =
  | { readonly kind: "accepted"; readonly status: 202; readonly body: {
      readonly pairingId: string; readonly pairingToken: string; readonly expiresIn: 120; readonly resendAfter: 60;
    } }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly code: "RATE_LIMITED" }
  | { readonly kind: "unavailable" };

export interface EnterprisePairingService {
  readonly request: (input: EnterprisePairingRequest) => Promise<EnterprisePairingResult>;
}

export function createEnterprisePairingService(options: EnterprisePairingServiceOptions): EnterprisePairingService {
  if (!options || [options.tenantKey, options.appId].some(value => typeof value !== "string" || value.length < 1
    || value.length > 256 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))) {
    throw new Error("INVALID_ENTERPRISE_PAIRING_CONFIG");
  }
  const budget = createAnonymousPairingBudget(options);
  const authority = Object.freeze({ expectation: Object.freeze({ ...options.expectation }),
    tenantKey: options.tenantKey, appId: options.appId });
  return Object.freeze({
    async request(input: EnterprisePairingRequest): Promise<EnterprisePairingResult> {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["loginName", "flowHash", "transport"].includes(key))
        || typeof input.loginName !== "string" || input.loginName.length < 1 || input.loginName.length > 64
        || typeof input.flowHash !== "string" || input.flowHash.length !== 64 || !/^[0-9a-f]{64}$/.test(input.flowHash)) {
        return { kind: "unavailable" };
      }
      const loginName = input.loginName;
      let pending: { pairingId: string; pairingToken: string } | undefined;
      try {
        const result = await budget.run({ flowHash: input.flowHash, transport: input.transport }, async context => {
          pending = await insertPendingPairing(context, authority, loginName);
          return pending.pairingId;
        });
        if (result.kind !== "accepted") return result;
        if (!pending || pending.pairingId !== result.pairingId) return { kind: "unavailable" };
        return { kind: "accepted", status: 202,
          body: { pairingId: pending.pairingId, pairingToken: pending.pairingToken, expiresIn: 120, resendAfter: 60 } };
      } catch { return { kind: "unavailable" }; }
      finally { pending = undefined; }
    },
  });
}
