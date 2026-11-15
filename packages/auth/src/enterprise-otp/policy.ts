// megaui-only (FS-19): enterprise auth operation allowlist and maintenance-mode gating.
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";

/** The only auth operations that remain reachable after enterprise activation. */
export const ENTERPRISE_AUTH_OPERATIONS = Object.freeze([
  "/enterprise/request",
  "/enterprise/status",
  "/enterprise/verify",
  "/enterprise/session",
  "/get-session",
  "/sign-out",
] as const);

export type EnterpriseAuthOperation = (typeof ENTERPRISE_AUTH_OPERATIONS)[number];
export type EnterpriseOperationMode = "legacy" | "enterprise" | "maintenance" | "reject";

export const AUTH_ROUTE_PREFIX = "/api/auth";
const ALLOWED_OPERATIONS = new Set<string>(ENTERPRISE_AUTH_OPERATIONS);

export interface EnterpriseOperationPolicyOptions {
  /** Read the current persistent policy on every request/direct API call. */
  readonly resolveMode: () => EnterpriseOperationMode | Promise<EnterpriseOperationMode>;
  /** Exact HTTP route prefix; trailing-slash and encoded path variants are rejected. */
  readonly httpBasePath?: string;
}

function unavailable(): never {
  throw new APIError("SERVICE_UNAVAILABLE", { message: "AUTH_OPERATION_POLICY_UNAVAILABLE" });
}

function denied(): never {
  throw new APIError("NOT_FOUND", { message: "AUTH_OPERATION_NOT_FOUND" });
}

function response(status: 404 | 503): Response {
  return new Response(JSON.stringify({ error: status === 404 ? "NOT_FOUND" : "UNAVAILABLE" }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function exactHttpOperation(request: Request, basePath: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (pathname === basePath) return "/";
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length);
}

export function isEnterpriseAuthOperation(path: string): path is EnterpriseAuthOperation {
  return ALLOWED_OPERATIONS.has(path);
}

/**
 * Guard both the HTTP router and direct `auth.api.*` dispatch. The hook is
 * intentionally attached to every endpoint, so adding a Better Auth plugin
 * or calling an admin/delete endpoint cannot create an unguarded operation.
 */
export function createEnterpriseOperationPolicy(
  options: EnterpriseOperationPolicyOptions,
): BetterAuthPlugin {
  if (!options || typeof options.resolveMode !== "function") {
    throw new Error("INVALID_ENTERPRISE_OPERATION_POLICY_CONFIG");
  }
  const httpBasePath = options.httpBasePath ?? AUTH_ROUTE_PREFIX;
  if (!httpBasePath.startsWith("/") || httpBasePath.endsWith("/")) {
    throw new Error("INVALID_ENTERPRISE_OPERATION_POLICY_PATH");
  }

  const currentMode = async (): Promise<EnterpriseOperationMode> => {
    try {
      const mode = await options.resolveMode();
      if (!["legacy", "enterprise", "maintenance", "reject"].includes(mode)) return "reject";
      return mode;
    } catch {
      return "reject";
    }
  };

  const guardDirectOperation = createAuthMiddleware(async (ctx) => {
    const mode = await currentMode();
    if (mode === "legacy") return;
    if (mode === "reject" ) unavailable();
    if (mode === "maintenance" && (ctx.path === "/get-session" || ctx.path === "/enterprise/session")) {
      return ctx.json(null);
    }
    if (mode === "maintenance" && ctx.path !== "/sign-out") denied();
    if (!ctx.path || !isEnterpriseAuthOperation(ctx.path)) denied();
  });

  return {
    id: "megaui-enterprise-operation-policy",
    version: "1",
    onRequest: async (request) => {
      const mode = await currentMode();
      if (mode === "legacy") return;
      if (mode === "reject") return { response: response(503) };
      const operation = exactHttpOperation(request, httpBasePath);
      if (mode === "maintenance" && operation !== "/get-session" && operation !== "/enterprise/session" && operation !== "/sign-out") {
        return { response: response(404) };
      }
      if (!operation || !isEnterpriseAuthOperation(operation)) return { response: response(404) };
    },
    hooks: {
      before: [{ matcher: () => true, handler: guardDirectOperation }],
    },
  };
}
