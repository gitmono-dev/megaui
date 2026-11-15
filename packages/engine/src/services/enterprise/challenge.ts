// megaui-only (FS-46): challenge and encrypted delivery creation.
/**
 * The engine owns the transaction-shaped persistence boundary but does not
 * import auth's crypto implementation. A structurally compatible crypto port
 * is injected by the application assembly, keeping key material outside this
 * package and making the transaction easy to exercise on isolated PostgreSQL.
 */
import { randomUUID } from "node:crypto";

import type { EnterpriseSenderBudgetClient } from "./sender-budget";

export interface EnterpriseOtpBinding {
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
  readonly tenantKey: string;
  readonly appId: string;
  readonly challengeId: string;
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly purpose: "login";
  readonly flowHash: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

export interface EnterpriseOtpCryptoPort {
  readonly digest: (
    code: string,
    binding: EnterpriseOtpBinding,
  ) => { readonly codeHmac: string; readonly hmacKeyId: string };
  readonly seal: (
    code: string,
    binding: EnterpriseOtpBinding,
  ) => { readonly encryptedPayload: string; readonly deliveryKeyId: string };
}

export interface EnterpriseChallengeInput {
  readonly client: EnterpriseSenderBudgetClient;
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
  readonly tenantKey: string;
  readonly appId: string;
  readonly pairingId: string;
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly flowHash: string;
  readonly generation: number;
  readonly nowMs: number;
  readonly messageId: string;
  readonly crypto: EnterpriseOtpCryptoPort;
  readonly generateCode: () => string;
}

export interface EnterpriseChallengeResult {
  readonly challengeId: string;
  readonly deliveryId: string;
}

const CHALLENGE_TTL_MS = 300_000;

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /\S/u.test(value);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function safeKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function safeEnvelope(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{48,8192}$/.test(value);
}

function requireValidInput(input: EnterpriseChallengeInput): void {
  if (
    !safeText(input.scope) ||
    !safeText(input.tenantKey) ||
    !safeText(input.appId) ||
    !safeText(input.pairingId) ||
    !safeText(input.localUserId) ||
    !safeText(input.identityId) ||
    !safeText(input.messageId) ||
    !safeHash(input.flowHash) ||
    !Number.isSafeInteger(input.identityVersion) ||
    input.identityVersion < 1 ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    input.nowMs > 8_639_999_999_400_000 ||
    typeof input.generateCode !== "function" ||
    typeof input.crypto?.digest !== "function" ||
    typeof input.crypto?.seal !== "function"
  ) {
    throw new Error("ENTERPRISE_CHALLENGE_INVALID_INPUT");
  }
}

/** Creates one 300-second challenge and its encrypted, expiry-bound DM row. */
export async function createEnterpriseChallenge(
  input: EnterpriseChallengeInput,
): Promise<EnterpriseChallengeResult> {
  requireValidInput(input);
  const challengeId = randomUUID();
  const deliveryId = randomUUID();
  const expiresAtMs = input.nowMs + CHALLENGE_TTL_MS;
  const binding: EnterpriseOtpBinding = {
    scope: input.scope,
    deploymentRole: input.deploymentRole,
    tenantKey: input.tenantKey,
    appId: input.appId,
    challengeId,
    localUserId: input.localUserId,
    identityId: input.identityId,
    identityVersion: input.identityVersion,
    purpose: "login",
    flowHash: input.flowHash,
    generation: input.generation,
    expiresAtMs,
  };
  const code = input.generateCode();
  const digest = input.crypto.digest(code, binding);
  const delivery = input.crypto.seal(code, binding);
  if (
    !safeHash(digest.codeHmac) ||
    !safeKeyId(digest.hmacKeyId) ||
    !safeKeyId(delivery.deliveryKeyId) ||
    !safeEnvelope(delivery.encryptedPayload)
  ) {
    throw new Error("ENTERPRISE_CHALLENGE_INVALID_CRYPTO_OUTPUT");
  }

  const createdAt = new Date(input.nowMs);
  const expiresAt = new Date(expiresAtMs);
  await input.client.query(
    `insert into enterprise_challenges
       (id, scope, deployment_role, local_user_id, identity_id,
        identity_version, flow_hash, generation, purpose, pairing_id,
        code_hmac, hmac_key_id, state, failed_attempts, created_at,
        expires_at, secret_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'login', $9,
        $10, $11, 'active', 0, $12, $13, $13)`,
    [
      challengeId,
      input.scope,
      input.deploymentRole,
      input.localUserId,
      input.identityId,
      input.identityVersion,
      input.flowHash,
      input.generation,
      input.pairingId,
      digest.codeHmac,
      digest.hmacKeyId,
      createdAt,
      expiresAt,
    ],
  );
  await input.client.query(
    `insert into enterprise_dm_deliveries
       (id, challenge_id, delivery_key_id, encrypted_payload, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [deliveryId, challengeId, delivery.deliveryKeyId, delivery.encryptedPayload, createdAt, expiresAt],
  );
  return { challengeId, deliveryId };
}

export const ENTERPRISE_CHALLENGE_TTL_MS = CHALLENGE_TTL_MS;
