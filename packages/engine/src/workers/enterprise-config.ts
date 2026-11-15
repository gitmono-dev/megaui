// megaui-only (FS-11): explicit worker scope and bounded native PostgreSQL configuration.
import { randomUUID } from "node:crypto";
import type { ClientConfig } from "pg";
import { resolveEnterpriseConfig, type AuthMode } from "@megaui/core";
import type { EnterpriseScopeExpectation } from "@megaui/database";
import type { AnonymousBudgetClient } from "../services/enterprise/anonymous-budget-types";
import { readPairingTarget } from "../services/enterprise/pairing-store";

export interface EnterpriseWorkerConfig {
  readonly connectionString: string;
  readonly authMode: AuthMode;
  readonly expectation?: EnterpriseScopeExpectation;
}

const invalid = () => new Error("INVALID_ENTERPRISE_WORKER_CONFIG");
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && ![...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);

export function readEnterpriseWorkerConfig(env: Record<string, string | undefined>): EnterpriseWorkerConfig {
  try {
    const connectionString = env.DATABASE_URL;
    if (typeof connectionString !== "string" || connectionString.length === 0) throw invalid();
    // Syntax only here; the real persistent activation gate runs on the selected DB below.
    const authMode = resolveEnterpriseConfig({ authMode: env.AUTH_MODE, activated: false }).mode;
    const fields = ["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE"] as const;
    const scoped = authMode !== "legacy" || fields.some(key => env[key] !== undefined) || env.ENTERPRISE_APPROVED_TARGETS !== undefined;
    if (!scoped) return Object.freeze({ connectionString, authMode });
    if (env.ENTERPRISE_APPROVED_TARGETS !== undefined || fields.some(key => !validText(env[key]))
      || env.ENTERPRISE_PROCESS_ROLE !== "worker" || !["development", "test", "production", "canary"].includes(env.ENTERPRISE_DEPLOYMENT_ROLE!)) throw invalid();
    return Object.freeze({ connectionString, authMode, expectation: Object.freeze({ processRole: "worker",
      ownerFingerprint: env.ENTERPRISE_OWNER_FINGERPRINT!, instanceId: env.ENTERPRISE_DB_INSTANCE_ID!, environment: env.ENTERPRISE_DEPLOYMENT_ROLE! }) });
  } catch { throw invalid(); }
}

/** URL/PGOPTIONS cannot override the owned worker's connection and SQL limits. */
export function workerConnectionConfig(connectionString: string, kind: "ordinary" | "cleanup" | "control"): ClientConfig {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length <= 1) throw invalid();
    for (const key of ["options", "statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "query_timeout",
      "connectionTimeoutMillis", "connect_timeout", "application_name", "fallback_application_name", "pipeline"]) url.searchParams.delete(key);
    const statement = kind === "ordinary" ? 9000 : kind === "cleanup" ? 3000 : 1000;
    return { connectionString: url.toString(), connectionTimeoutMillis: 1000, query_timeout: statement,
      statement_timeout: statement, lock_timeout: kind === "ordinary" ? 9000 : 1000,
      idle_in_transaction_session_timeout: statement, pipeline: false,
      application_name: `megaui-${kind}-${randomUUID()}`,
      options: `-c statement_timeout=${statement} -c lock_timeout=${kind === "ordinary" ? 9000 : 1000} -c idle_in_transaction_session_timeout=${statement}` };
  } catch { throw invalid(); }
}

/** This read-only check must precede even the legacy recurring-job insert. */
export async function preflightEnterpriseWorker(client: AnonymousBudgetClient, config: EnterpriseWorkerConfig): Promise<void> {
  try {
    if (config.expectation) { await readPairingTarget(client, config.expectation, config.authMode); return; }
    const result = await client.query<{ activated: boolean }>(`select coalesce(bool_or(activation_state <> 'legacy' or auth_epoch <> 0),false) as activated
      from enterprise_policy`);
    if (config.authMode !== "legacy" || result.rows[0]?.activated !== false) throw invalid();
  } catch { throw new Error("ENTERPRISE_WORKER_TARGET_REJECTED"); }
}

/** A single absolute deadline; the owner has already sealed and cancelled its resources. */
export async function workerDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ENTERPRISE_WORKER_SHUTDOWN_FAILED")), Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer); }
}
