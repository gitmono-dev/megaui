// megaui-only (FS-74): anonymous pairing budgets have no upstream counterpart.
import type { Pool } from "pg";
import type { EnterpriseScopeExpectation } from "@megaui/database";

export interface AnonymousTransport {
  readonly peerAddress: string;
  readonly forwardedFor?: string;
}

/** This connection belongs to the budget transaction; callers cannot release it. */
export interface AnonymousBudgetClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface AnonymousPendingContext {
  readonly client: AnonymousBudgetClient;
  readonly scope: string;
  readonly deploymentRole: string;
  readonly flowHash: string;
  readonly nowMs: number;
}

export interface AnonymousBudgetAlert {
  readonly event: "enterprise.anonymous-budget.saturated";
  readonly reason: "ip" | "flow" | "capacity";
  readonly scopeFingerprint: string;
  readonly at: string;
}

export interface AnonymousPairingBudgetOptions {
  readonly pool: Pool;
  readonly expectation: EnterpriseScopeExpectation;
  readonly proxyCidrs: readonly string[];
  readonly ipHmacMaster: Uint8Array;
  /** Trusted synchronous sink. External delivery and background work are unsupported. */
  readonly alert: (event: Readonly<AnonymousBudgetAlert>) => undefined;
}

export type AnonymousPairingBudgetResult =
  | { readonly kind: "accepted"; readonly pairingId: string }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly code: "RATE_LIMITED" }
  | { readonly kind: "unavailable" };

export interface AnonymousPairingBudget {
  run(
    input: { readonly transport: AnonymousTransport; readonly flowHash: string },
    createPending: (context: Readonly<AnonymousPendingContext>) => Promise<string>,
  ): Promise<AnonymousPairingBudgetResult>;
}
