// megaui-only (FS-36): strict auth-boundary input and the OTP consume port.
import {
  createEnterpriseGrantStore,
  type EnterpriseGrantConsumeResult,
  type EnterpriseGrantQualification,
} from "@megaui/database";
import type { getPool } from "@megaui/database";
import { normalizeEnterpriseOtpInput } from "./input";
import type { EnterpriseOtpCrypto } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ROLE = new Set(["development", "test", "production", "canary"]);

export interface EnterpriseOtpConsumerOptions {
  readonly pool: ReturnType<typeof getPool>;
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
  readonly tenantKey: string;
  readonly appId: string;
  readonly crypto: EnterpriseOtpCrypto;
  readonly qualify: EnterpriseGrantQualification;
  /** Test-only clock injection; production uses the process clock. */
  readonly now?: () => Date;
}

export interface EnterpriseOtpConsumeInput {
  readonly challengeId: unknown;
  readonly flowHash: unknown;
  readonly code: unknown;
}

export interface EnterpriseOtpConsumer {
  readonly consume: (input: EnterpriseOtpConsumeInput) => Promise<EnterpriseGrantConsumeResult>;
  readonly cleanupExpiredSecrets: (input?: { readonly now?: Date; readonly limit?: number }) => Promise<number>;
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /\S/u.test(value)
    && ![...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function validOptions(options: EnterpriseOtpConsumerOptions): boolean {
  return !!options && typeof options === "object"
    && typeof options.pool?.connect === "function"
    && safeText(options.scope) && ROLE.has(options.deploymentRole)
    && safeText(options.tenantKey) && safeText(options.appId)
    && typeof options.crypto?.verify === "function"
    && typeof options.qualify === "function"
    && (options.now === undefined || typeof options.now === "function");
}

export function createEnterpriseOtpConsumer(options: EnterpriseOtpConsumerOptions): EnterpriseOtpConsumer {
  if (!validOptions(options)) throw new Error("INVALID_ENTERPRISE_OTP_CONSUMER_CONFIG");
  const store = createEnterpriseGrantStore(options.pool);
  const scope = options.scope;
  const deploymentRole = options.deploymentRole;
  const tenantKey = options.tenantKey;
  const appId = options.appId;
  const crypto = options.crypto;
  const qualify = options.qualify;
  const now = options.now;

  return Object.freeze({
    async consume(input: EnterpriseOtpConsumeInput): Promise<EnterpriseGrantConsumeResult> {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((key) => !["challengeId", "flowHash", "code"].includes(key))
        || typeof input.challengeId !== "string" || !UUID.test(input.challengeId)
        || typeof input.flowHash !== "string" || !HASH.test(input.flowHash)) {
        return { kind: "invalid" };
      }
      const code = normalizeEnterpriseOtpInput(input.code);
      if (code === null) return { kind: "invalid" };
      return store.consume({
        challengeId: input.challengeId,
        scope,
        deploymentRole,
        tenantKey,
        appId,
        flowHash: input.flowHash,
        code,
        now: now?.(),
        verifyCode: (candidate, binding, record) => {
          try { return crypto.verify(candidate, binding, record); } catch { return false; }
        },
        qualify,
      });
    },
    cleanupExpiredSecrets(input = {}) {
      return store.cleanupExpiredSecrets(input);
    },
  });
}
