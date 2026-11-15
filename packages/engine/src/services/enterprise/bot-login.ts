// megaui-only (FS-46): atomic pairing confirmation, challenge and DM outbox.
/**
 * Consumes the FS-76 admission result and runs the complete trusted-sender
 * path through FS-75. The sender budget owns the transaction; this module
 * only mutates pairing/challenge/delivery inside its callback, so any failure
 * rolls back the budget reservation and every business row together.
 */
import { Pool } from "pg";

import { type AuthMode } from "@megaui/core";
import { type EnterpriseScopeExpectation } from "@megaui/database";

import {
  createEnterpriseEligibilityService,
  createPostgresAuthenticationEligibilityReader,
} from "./eligibility";
import type {
  EnterpriseBotCommandInput,
  EnterpriseBotCommandResult,
  EnterpriseBotCommandService,
} from "./bot-command";
import {
  createEnterpriseChallenge,
  type EnterpriseChallengeResult,
  type EnterpriseOtpCryptoPort,
} from "./challenge";
import type { DirectoryScope } from "./feishu/directory";
import {
  createEnterpriseSenderBudget,
  type EnterpriseSenderBudget,
  type EnterpriseSenderBudgetClient,
} from "./sender-budget";

export interface EnterpriseBotLoginOptions {
  readonly pool: Pool;
  readonly expectation: EnterpriseScopeExpectation;
  readonly tenantKey: string;
  readonly appId: string;
  readonly directoryScope: DirectoryScope;
  readonly authMode: AuthMode;
  readonly botCommand: EnterpriseBotCommandService;
  readonly senderBudget?: EnterpriseSenderBudget;
  readonly crypto: EnterpriseOtpCryptoPort;
  readonly generateCode: () => string;
}

export type EnterpriseBotLoginResult =
  | ({ readonly kind: "accepted" } & EnterpriseChallengeResult)
  | { readonly kind: "duplicate"; readonly messageId: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly code: "RATE_LIMITED" }
  | { readonly kind: "unavailable" };

export interface EnterpriseBotLoginService {
  readonly consume: (
    input: EnterpriseBotCommandInput,
  ) => Promise<EnterpriseBotLoginResult>;
}

interface PairingRow extends Record<string, unknown> {
  pairingId: string;
  identityId: string;
  localUserId: string;
  identityVersion: number;
  openId: string;
  authEpoch: number;
  flowHash: string;
  generation: number;
  state: string;
  tenantKey: string;
  appId: string;
  expiresAt: Date;
  nowAt: Date;
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /\S/u.test(value);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function resultFromAdmission(
  admission: EnterpriseBotCommandResult,
): Exclude<EnterpriseBotLoginResult, { kind: "accepted" } | { kind: "duplicate" }> | undefined {
  if (admission.kind === "rejected") return { kind: "rejected", reason: admission.reason };
  if (admission.kind === "unavailable") return { kind: "unavailable" };
  return undefined;
}

export function createEnterpriseBotLoginService(
  options: EnterpriseBotLoginOptions,
): EnterpriseBotLoginService {
  if (
    !options ||
    !(options.pool instanceof Pool) ||
    !options.expectation ||
    !safeText(options.tenantKey) ||
    !safeText(options.appId) ||
    !options.directoryScope ||
    typeof options.botCommand?.admit !== "function" ||
    !options.crypto ||
    typeof options.crypto.digest !== "function" ||
    typeof options.crypto.seal !== "function" ||
    typeof options.generateCode !== "function"
  ) {
    throw new Error("INVALID_ENTERPRISE_BOT_LOGIN_CONFIG");
  }
  const pool = options.pool;
  const expectation = Object.freeze({ ...options.expectation });
  const tenantKey = options.tenantKey;
  const appId = options.appId;
  const botCommand = options.botCommand;
  const senderBudget = options.senderBudget ?? createEnterpriseSenderBudget({
    pool,
    expectation,
    tenantKey,
    appId,
  });
  const crypto = options.crypto;
  const generateCode = options.generateCode;

  async function readPairing(
    client: EnterpriseSenderBudgetClient,
    pairingId: string,
  ): Promise<PairingRow | undefined> {
    const result = await client.query<PairingRow>(
      `select pairing.id as "pairingId",
              identity.id as "identityId",
              identity.local_user_id as "localUserId",
              identity.identity_version as "identityVersion",
              identity.open_id as "openId",
              policy.auth_epoch as "authEpoch",
              pairing.flow_hash as "flowHash",
              pairing.generation,
              pairing.state,
              pairing.tenant_key as "tenantKey",
              pairing.app_id as "appId",
              pairing.expires_at as "expiresAt",
              clock_timestamp() as "nowAt"
         from enterprise_pairings as pairing
         join enterprise_identity as identity
           on identity.id = pairing.intended_identity_id
          and identity.tenant_key = pairing.tenant_key
          and identity.app_id = pairing.app_id
         join enterprise_policy as policy
           on policy.scope = pairing.scope
          and policy.deployment_role = pairing.deployment_role
        where pairing.id = $1
          and pairing.scope = $2
          and pairing.deployment_role = $3
          and pairing.tenant_key = $4
          and pairing.app_id = $5
          and pairing.purpose = 'login'
        for update of pairing, identity`,
      [pairingId, expectation.instanceId, expectation.environment, tenantKey, appId],
    );
    if (result.rows.length > 1) throw new Error("BOT_LOGIN_AMBIGUOUS_PAIRING");
    return result.rows[0];
  }

  async function transactionalEligibility(
    client: EnterpriseSenderBudgetClient,
    pairing: PairingRow,
    nowMs: number,
  ): Promise<boolean> {
    const reader = createPostgresAuthenticationEligibilityReader({
      query: async (text, values) => {
        const result = await client.query(text, values);
        return { rows: result.rows };
      },
    });
    const service = createEnterpriseEligibilityService({
      directoryScope: options.directoryScope,
      policyScope: expectation.instanceId,
      authMode: options.authMode,
      databaseReader: reader,
      directoryReader: {
        tenantKey,
        appId,
        read: async () => Promise.reject(new Error("bot login must not call provider")),
      },
      now: () => new Date(nowMs),
    });
    return service.authenticationEligibility(
      pairing.localUserId,
      pairing.identityId,
      pairing.authEpoch,
    );
  }

  async function consume(input: EnterpriseBotCommandInput): Promise<EnterpriseBotLoginResult> {
    const admission = await botCommand.admit(input);
    const admissionResult = resultFromAdmission(admission);
    if (admissionResult) return admissionResult;
    if (admission.kind !== "accepted") return { kind: "unavailable" };

    const duplicate = await pool.query<{ messageId: string }>(
      `select confirmed_message_id as "messageId"
         from enterprise_pairings
        where scope = $1 and deployment_role = $2
          and tenant_key = $3 and app_id = $4
          and purpose = 'login' and confirmed_message_id = $5
        limit 1`,
      [expectation.instanceId, expectation.environment, tenantKey, appId, admission.messageId],
    );
    if (duplicate.rows.length > 1) return { kind: "unavailable" };
    if (duplicate.rows.length === 1) return { kind: "duplicate", messageId: admission.messageId };

    const result = await senderBudget.run(
      {
        senderOpenId: admission.senderOpenId,
        identityId: admission.identityId,
        flowHash: admission.flowHash,
        validToken: true,
      },
      async (context) => {
        const pairing = await readPairing(context.client, admission.pairingId);
        if (!pairing || pairing.identityId !== admission.identityId || pairing.localUserId !== admission.localUserId
          || pairing.flowHash !== admission.flowHash || pairing.openId !== admission.senderOpenId
          || pairing.tenantKey !== tenantKey || pairing.appId !== appId
          || pairing.state !== "pending" || !validDate(pairing.expiresAt) || !validDate(pairing.nowAt)
          || pairing.expiresAt.getTime() <= pairing.nowAt.getTime()) {
          throw new Error("BOT_LOGIN_PAIRING_REJECTED");
        }
        if (!(await transactionalEligibility(context.client, pairing, context.nowMs))) {
          throw new Error("BOT_LOGIN_INELIGIBLE");
        }
        await context.client.query(
          `update enterprise_pairings
              set state = 'confirmed',
                  confirmed_identity_version = $2,
                  confirmed_message_id = $3,
                  confirmed_at = $4,
                  retain_until = $4::timestamptz + interval '390 seconds'
            where id = $1 and state = 'pending'`,
          [pairing.pairingId, pairing.identityVersion, admission.messageId, new Date(context.nowMs)],
        );
        return createEnterpriseChallenge({
          client: context.client,
          scope: expectation.instanceId,
          deploymentRole: expectation.environment as "development" | "test" | "production" | "canary",
          tenantKey,
          appId,
          pairingId: pairing.pairingId,
          localUserId: pairing.localUserId,
          identityId: pairing.identityId,
          identityVersion: pairing.identityVersion,
          flowHash: pairing.flowHash,
          generation: pairing.generation,
          nowMs: context.nowMs,
          messageId: admission.messageId,
          crypto,
          generateCode,
        });
      },
    );
    if (result.kind === "accepted") return { kind: "accepted", ...result.value };
    if (result.kind === "rate-limited") return result;
    return { kind: "unavailable" };
  }

  return Object.freeze({ consume });
}
