/**
 * FS-65: collab is a policy consumer, never a second policy authority.
 *
 * The bridge has no database access. It reads the Web policy projection for
 * every startup/connection check and fails closed on transport, schema, scope,
 * or artifact drift.
 */
import {
  AUTH_MODES,
  createEnterprisePolicyResponse,
  parseEnterprisePolicyResponse,
  type AuthMode,
  type EnterprisePolicyResponse,
} from "@megaui/core";

export const ENTERPRISE_POLICY_PATH = "/api/internal/enterprise/eligibility";
const DEFAULT_POLICY_TIMEOUT_MS = 3_000;

export class EnterprisePolicyError extends Error {
  readonly code = "ENTERPRISE_POLICY_UNAVAILABLE" as const;

  constructor(message = "Enterprise policy is unavailable") {
    super(message);
    this.name = "EnterprisePolicyError";
  }
}

export interface EnterprisePolicyBridge {
  read: () => Promise<EnterprisePolicyResponse>;
  qualify?: (input: EnterpriseEligibilityInput) => Promise<boolean>;
}

export interface EnterpriseEligibilityInput {
  readonly localUserId: string;
  readonly identityId: string;
  readonly authEpoch: number;
}

export interface EnterprisePolicyBridgeOptions {
  readonly webOrigin: string;
  readonly serviceKey: string;
  readonly expectedInstanceId?: string;
  readonly expectedArtifactSha?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function fixedOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new EnterprisePolicyError("Invalid Web policy origin");
  }
}

function validText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256 &&
    ![...value].some(character => (character.codePointAt(0) ?? 0) <= 0x1f || character === "\u007f");
}

/** The local process mode is a compatibility guard, not a policy source. */
export function resolveCollabAuthMode(raw = process.env.AUTH_MODE): AuthMode {
  const mode = raw?.trim() || "legacy";
  if (!(AUTH_MODES as readonly string[]).includes(mode)) {
    throw new EnterprisePolicyError("Invalid AUTH_MODE");
  }
  return mode as AuthMode;
}

/** Reject a local mode that could accidentally widen the Web policy. */
export function assertCollabPolicyCompatible(
  localMode: AuthMode,
  policy: EnterprisePolicyResponse,
): void {
  const compatible = localMode === "legacy"
    ? policy.effective_mode === "legacy"
    : localMode === "maintenance"
      ? policy.effective_mode === "enterprise" || policy.effective_mode === "maintenance"
      : policy.effective_mode === "enterprise" || policy.effective_mode === "maintenance";
  if (!compatible) throw new EnterprisePolicyError("Local mode is incompatible with Web policy");
}

/** Apply the local maintenance override without weakening the remote policy. */
export function policyForCollabMode(
  localMode: AuthMode,
  policy: EnterprisePolicyResponse,
): EnterprisePolicyResponse {
  assertCollabPolicyCompatible(localMode, policy);
  if (localMode !== "maintenance" || policy.effective_mode === "maintenance") return policy;
  return createEnterprisePolicyResponse({
    effectiveMode: "maintenance",
    policyEpoch: policy.policy_epoch,
    instanceId: policy.instance_id,
    artifactSha: policy.artifact_sha,
  });
}

export function createEnterprisePolicyBridge(options: EnterprisePolicyBridgeOptions): EnterprisePolicyBridge {
  const origin = fixedOrigin(options.webOrigin);
  if (!validText(options.serviceKey)) throw new EnterprisePolicyError("Invalid policy service key");
  if (options.expectedInstanceId !== undefined && !validText(options.expectedInstanceId)) {
    throw new EnterprisePolicyError("Invalid expected policy instance");
  }
  if (options.expectedArtifactSha !== undefined && !/^[a-f0-9]{64}$/u.test(options.expectedArtifactSha)) {
    throw new EnterprisePolicyError("Invalid expected policy artifact");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new EnterprisePolicyError("Invalid policy timeout");
  }

  const post = async (body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${ENTERPRISE_POLICY_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new EnterprisePolicyError();
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new EnterprisePolicyError();
    }
    try {
      const text = await response.text();
      if (text.length > 4096) throw new Error();
      return JSON.parse(text) as unknown;
    } catch {
      throw new EnterprisePolicyError();
    }
  };

  return Object.freeze({
    read: async (): Promise<EnterprisePolicyResponse> => {
      const raw = await post({ op: "policy" });
      const policy = parseEnterprisePolicyResponse(raw);
      if (!policy ||
        (options.expectedInstanceId !== undefined && policy.instance_id !== options.expectedInstanceId) ||
        (options.expectedArtifactSha !== undefined && policy.artifact_sha !== options.expectedArtifactSha)) {
        throw new EnterprisePolicyError();
      }
      return policy;
    },
    qualify: async (input: EnterpriseEligibilityInput): Promise<boolean> => {
      if (!validText(input.localUserId) || !validText(input.identityId) ||
        !Number.isSafeInteger(input.authEpoch) || input.authEpoch < 0) {
        throw new EnterprisePolicyError();
      }
      const raw = await post({
        localUserId: input.localUserId,
        identityId: input.identityId,
        authEpoch: input.authEpoch,
      });
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new EnterprisePolicyError();
      const record = raw as Record<string, unknown>;
      if (Object.keys(record).sort().join(",") !== "eligible" || typeof record.eligible !== "boolean") {
        throw new EnterprisePolicyError();
      }
      return record.eligible;
    },
  });
}

/** Construct the bridge only when this collab process declares enterprise scope. */
export function bridgeFromEnvironment(): EnterprisePolicyBridge | undefined {
  const mode = resolveCollabAuthMode();
  const webOrigin = process.env.BETTER_AUTH_URL?.trim();
  const serviceKey = process.env.ENTERPRISE_INTROSPECTION_KEY?.trim();
  const expectedInstanceId = process.env.ENTERPRISE_DB_INSTANCE_ID?.trim();
  const expectedArtifactSha = process.env.ENTERPRISE_ARTIFACT_SHA?.trim();
  const enterpriseDeclared = mode !== "legacy" || serviceKey !== undefined ||
    expectedInstanceId !== undefined || expectedArtifactSha !== undefined;
  if (!enterpriseDeclared) return undefined;
  if (!webOrigin || !serviceKey || !expectedInstanceId || !expectedArtifactSha) {
    throw new EnterprisePolicyError("Incomplete enterprise policy bridge configuration");
  }
  return createEnterprisePolicyBridge({ webOrigin, serviceKey, expectedInstanceId, expectedArtifactSha });
}
