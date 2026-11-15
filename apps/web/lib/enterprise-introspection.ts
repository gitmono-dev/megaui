// megaui-only (FS-41): the one service-key protected qualification boundary.
import { compareBearerToken, extractBearerToken } from "@megaui/engine";
import { createEnterprisePolicyResponse, resolveEffectiveAuthMode, type EnterprisePolicyResponse } from "@megaui/core";
import { z } from "zod";

import { prepareWebAuth } from "./auth";
import { readEnterpriseWebConfig } from "./enterprise-config";
import { resolveEnterpriseEligibility } from "./enterprise-session";
import { getReadyWebAssembly } from "./enterprise-runtime";

export const ENTERPRISE_INTROSPECTION_PATH = "/api/internal/enterprise/eligibility";
export const ENTERPRISE_INTROSPECTION_KEY_ENV = "ENTERPRISE_INTROSPECTION_KEY";

const requestSchema = z.object({
  localUserId: z.string().trim().min(1).max(256),
  identityId: z.string().trim().min(1).max(256),
  authEpoch: z.number().int().nonnegative().safe(),
}).strict();
const policyRequestSchema = z.object({ op: z.literal("policy") }).strict();
const introspectionRequestSchema = z.union([requestSchema, policyRequestSchema]);

export type EnterpriseEligibilityRequest = z.infer<typeof requestSchema>;

export interface EnterpriseIntrospectionPorts {
  readonly expectedKey: () => string | undefined;
  readonly qualify: (input: EnterpriseEligibilityRequest) => Promise<boolean | null>;
  readonly policy?: () => Promise<EnterprisePolicyResponse | null>;
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status });
}

function authorized(request: Request, expectedKey: string | undefined): boolean {
  const provided = extractBearerToken(request.headers.get("authorization"));
  return Boolean(expectedKey && compareBearerToken(provided, expectedKey));
}

export function createEnterpriseIntrospectionHandler(ports: EnterpriseIntrospectionPorts) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED");
    if (!authorized(request, ports.expectedKey())) return jsonError(401, "UNAUTHORIZED");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "INVALID_REQUEST");
    }
    const parsed = introspectionRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "INVALID_REQUEST");

    if ("op" in parsed.data) {
      if (!ports.policy) return jsonError(503, "ENTERPRISE_INTROSPECTION_UNAVAILABLE");
      try {
        const policy = await ports.policy();
        return policy === null
          ? jsonError(503, "ENTERPRISE_INTROSPECTION_UNAVAILABLE")
          : Response.json(policy, { status: 200 });
      } catch {
        return jsonError(503, "ENTERPRISE_INTROSPECTION_UNAVAILABLE");
      }
    }

    let eligible: boolean | null;
    try {
      eligible = await ports.qualify(parsed.data);
    } catch {
      eligible = null;
    }
    if (eligible === null) return jsonError(503, "ENTERPRISE_INTROSPECTION_UNAVAILABLE");
    return Response.json({ eligible }, { status: 200 });
  };
}

export const handleEnterpriseIntrospection = createEnterpriseIntrospectionHandler({
  expectedKey: () => process.env[ENTERPRISE_INTROSPECTION_KEY_ENV],
  qualify: resolveEnterpriseEligibility,
  policy: resolveEnterprisePolicy,
});

/** Read the current persisted policy for the authenticated server-to-server path. */
export async function resolveEnterprisePolicy(): Promise<EnterprisePolicyResponse | null> {
  try {
    const config = readEnterpriseWebConfig();
    const scope = config.scope;
    const assembly = getReadyWebAssembly(prepareWebAuth);
    const artifactSha = process.env.ENTERPRISE_ARTIFACT_SHA?.trim();
    if (!scope || !assembly || !artifactSha) return null;
    const result = await assembly.database.pool.query<{
      scope: string;
      owner_fingerprint: string;
      deployment_role: string;
      environment: string;
      activation_state: string;
      auth_epoch: number;
    }>(`select scope, owner_fingerprint, deployment_role, environment, activation_state, auth_epoch
          from enterprise_policy where scope = $1 limit 2`, [scope.instanceId]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || row.scope !== scope.instanceId
      || row.owner_fingerprint !== scope.ownerFingerprint
      || row.deployment_role !== scope.environment || row.environment !== scope.environment
      || !Number.isSafeInteger(row.auth_epoch) || row.auth_epoch < 0) return null;
    const effectiveMode = resolveEffectiveAuthMode(config.mode, row.activation_state);
    if (effectiveMode === "reject") return null;
    return createEnterprisePolicyResponse({
      effectiveMode,
      policyEpoch: row.auth_epoch,
      instanceId: row.scope,
      artifactSha,
    });
  } catch {
    return null;
  }
}
