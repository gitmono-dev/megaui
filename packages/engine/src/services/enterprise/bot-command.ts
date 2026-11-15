// megaui-only (FS-76): verified private-message bot-command admission.
/**
 * FS-76：只把已验签 inbox 中的严格 `/login <opaque-token>` 投影推进到
 * FS-46。回调 verifier 已经把正文解析为 token digest；本模块不接受、不
 * 记录也不重新解析私聊正文。
 */
import { Pool } from "pg";

import {
  assertEnterpriseScope,
  type EnterpriseScopeExpectation,
} from "@megaui/database";

import {
  readPersistedVerifiedPrivateMessageEvent,
  type PersistedVerifiedPrivateMessageEvent,
} from "./events";
import type { EnterpriseEligibilityService } from "./eligibility";

export interface EnterpriseBotCommandOptions {
  readonly pool: Pool;
  readonly expectation: EnterpriseScopeExpectation;
  readonly tenantKey: string;
  readonly appId: string;
  /** FS-10 authority; this call never reaches the provider. */
  readonly eligibility: EnterpriseEligibilityService;
}

export type EnterpriseBotCommandInput =
  | PersistedVerifiedPrivateMessageEvent
  | { readonly inboxId: string };

export type EnterpriseBotCommandRejection =
  | "not-a-login-command"
  | "group-chat"
  | "bot-sender"
  | "non-text"
  | "sender-mismatch"
  | "unknown-pairing"
  | "expired-pairing"
  | "ineligible-identity";

export type EnterpriseBotCommandResult =
  | {
      readonly kind: "accepted";
      readonly pairingId: string;
      readonly identityId: string;
      readonly localUserId: string;
      readonly flowHash: string;
      readonly generation: number;
      readonly senderOpenId: string;
      readonly messageId: string;
    }
  | { readonly kind: "rejected"; readonly reason: EnterpriseBotCommandRejection }
  | { readonly kind: "unavailable" };

export interface EnterpriseBotCommandService {
  readonly admit: (
    input: EnterpriseBotCommandInput,
  ) => Promise<EnterpriseBotCommandResult>;
  readonly admitInbox: (inboxId: string) => Promise<EnterpriseBotCommandResult>;
}

interface PairingRow {
  pairingId: string;
  identityId: string | null;
  localUserId: string | null;
  openId: string | null;
  authEpoch: number | null;
  flowHash: string;
  generation: number;
  state: string;
  expiresAt: Date;
  scope: string;
  deploymentRole: string;
  tenantKey: string;
  appId: string;
  ownerFingerprint: string;
  activationState: string;
  roleName: string;
  canDdl: boolean;
  canCreateDb: boolean;
  nowAt: Date;
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    /\S/u.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  );
}

function safeDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validEvent(
  value: unknown,
): value is PersistedVerifiedPrivateMessageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<PersistedVerifiedPrivateMessageEvent>;
  return (
    safeText(event.inboxId) &&
    safeText(event.tenantKey) &&
    safeText(event.appId) &&
    safeText(event.eventId) &&
    event.eventType === "im.message.receive_v1" &&
    validDate(event.eventCreatedAt) &&
    safeText(event.messageId) &&
    safeText(event.senderOpenId) &&
    safeText(event.senderType) &&
    safeText(event.chatType) &&
    safeText(event.messageType) &&
    (event.pairingTokenDigest === undefined || safeDigest(event.pairingTokenDigest))
  );
}

function rejected(reason: EnterpriseBotCommandRejection): EnterpriseBotCommandResult {
  return { kind: "rejected", reason };
}

function unavailable(): EnterpriseBotCommandResult {
  return { kind: "unavailable" };
}

function assertOptionText(value: unknown, field: string): asserts value is string {
  if (!safeText(value)) {
    throw new Error(`[@megaui/engine] bot command ${field} is invalid`);
  }
}

/**
 * Creates the fail-closed admission port used by the private-message owner.
 * The SQL lookup binds every pairing authority field and the sender binding;
 * eligibility is then rechecked against the current directory watermark,
 * identity status, local-ban state and auth epoch.
 */
export function createEnterpriseBotCommandService(
  options: EnterpriseBotCommandOptions,
): EnterpriseBotCommandService {
  if (!options || !(options.pool instanceof Pool)) {
    throw new Error("INVALID_ENTERPRISE_BOT_COMMAND_CONFIG");
  }
  assertOptionText(options.tenantKey, "tenantKey");
  assertOptionText(options.appId, "appId");
  if (!options.expectation || typeof options.eligibility?.authenticationEligibility !== "function") {
    throw new Error("INVALID_ENTERPRISE_BOT_COMMAND_CONFIG");
  }
  const tenantKey = options.tenantKey;
  const appId = options.appId;
  const expectation = Object.freeze({ ...options.expectation });
  const pool = options.pool;
  const eligibility = options.eligibility;

  async function readEvent(
    input: EnterpriseBotCommandInput,
  ): Promise<PersistedVerifiedPrivateMessageEvent | undefined> {
    if (
      input &&
      typeof input === "object" &&
      "inboxId" in input &&
      Object.keys(input).length === 1
    ) {
      return readPersistedVerifiedPrivateMessageEvent(pool, input.inboxId);
    }
    return validEvent(input) ? input : undefined;
  }

  async function readPairing(
    event: PersistedVerifiedPrivateMessageEvent,
  ): Promise<PairingRow | undefined> {
    const result = await pool.query<PairingRow>(
      `select pairing.id as "pairingId",
              pairing.intended_identity_id as "identityId",
              identity.local_user_id as "localUserId",
              identity.open_id as "openId",
              policy.auth_epoch as "authEpoch",
              pairing.flow_hash as "flowHash",
              pairing.generation,
              pairing.state,
              pairing.expires_at as "expiresAt",
              policy.scope,
              policy.deployment_role as "deploymentRole",
              pairing.tenant_key as "tenantKey",
              pairing.app_id as "appId",
              policy.owner_fingerprint as "ownerFingerprint",
              policy.activation_state as "activationState",
              current_user as "roleName",
              has_schema_privilege(current_user, 'public', 'CREATE') as "canDdl",
              has_database_privilege(current_user, current_database(), 'CREATE') as "canCreateDb",
              clock_timestamp() as "nowAt"
         from enterprise_pairings as pairing
         join enterprise_policy as policy
           on policy.scope = pairing.scope
          and policy.deployment_role = pairing.deployment_role
         left join enterprise_identity as identity
           on identity.id = pairing.intended_identity_id
          and identity.tenant_key = pairing.tenant_key
          and identity.app_id = pairing.app_id
        where pairing.token_hash = $1
          and pairing.scope = $2
          and pairing.deployment_role = $3
          and pairing.tenant_key = $4
          and pairing.app_id = $5
          and pairing.purpose = 'login'`,
      [event.pairingTokenDigest, expectation.instanceId, expectation.environment, tenantKey, appId],
    );
    if (result.rows.length > 1) throw new Error("BOT_COMMAND_AMBIGUOUS_PAIRING");
    const row = result.rows[0];
    if (row === undefined) return undefined;
    assertEnterpriseScope({
      expectation,
      marker: {
        scope: row.scope,
        ownerFingerprint: row.ownerFingerprint,
        environment: row.deploymentRole,
        activationState: row.activationState,
        authEpoch: row.authEpoch ?? 0,
      },
      privileges: {
        roleName: row.roleName,
        canDdl: row.canDdl,
        canCreateDatabase: row.canCreateDb,
      },
    });
    if (row.activationState !== "enterprise") return undefined;
    return row;
  }

  async function admit(input: EnterpriseBotCommandInput): Promise<EnterpriseBotCommandResult> {
    const event = await readEvent(input);
    if (!event) return rejected("not-a-login-command");
    if (event.tenantKey !== tenantKey || event.appId !== appId) return rejected("unknown-pairing");
    if (event.senderType === "bot") return rejected("bot-sender");
    if (event.chatType !== "p2p") return rejected("group-chat");
    if (event.senderType !== "user") return rejected("bot-sender");
    if (event.messageType !== "text") return rejected("non-text");
    if (!event.pairingTokenDigest) return rejected("not-a-login-command");

    try {
      const pairing = await readPairing(event);
      if (!pairing) return rejected("unknown-pairing");
      if (
        pairing.identityId === null ||
        pairing.localUserId === null ||
        pairing.openId === null ||
        pairing.authEpoch === null
      ) {
        return rejected("sender-mismatch");
      }
      if (pairing.openId !== event.senderOpenId) return rejected("sender-mismatch");
      if (
        pairing.state !== "pending" ||
        !validDate(pairing.expiresAt) ||
        !validDate(pairing.nowAt) ||
        pairing.expiresAt.getTime() <= pairing.nowAt.getTime()
      ) {
        return rejected("expired-pairing");
      }
      if (pairing.scope !== expectation.instanceId || pairing.deploymentRole !== expectation.environment) {
        return rejected("unknown-pairing");
      }
      if (!Number.isSafeInteger(pairing.authEpoch) || pairing.authEpoch < 0) {
        return unavailable();
      }
      const eligible = await eligibility.authenticationEligibility(
        pairing.localUserId,
        pairing.identityId,
        pairing.authEpoch,
      );
      if (!eligible) return rejected("ineligible-identity");
      return {
        kind: "accepted",
        pairingId: pairing.pairingId,
        identityId: pairing.identityId,
        localUserId: pairing.localUserId,
        flowHash: pairing.flowHash,
        generation: pairing.generation,
        senderOpenId: event.senderOpenId,
        messageId: event.messageId,
      };
    } catch {
      return unavailable();
    }
  }

  async function admitInbox(inboxId: string): Promise<EnterpriseBotCommandResult> {
    return admit({ inboxId });
  }

  // The policy row and SQL role are checked on every read, so activation or
  // scope changes fail closed rather than being hidden by a stale factory.
  return Object.freeze({ admit, admitInbox });
}
