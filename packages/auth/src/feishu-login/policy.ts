// megaui-only (FSL-127: the Feishu-mode operation allowlist; 原参照见 docs/implementation/feishu-login.md「来源」)
//
// Diff vs the enterprise operation policy (GC-03): no persistent mode — `createAuth` registers this
// policy exactly when it receives the `feishuLogin` option, and then does not register the
// enterprise policy; the allowlist is the four Feishu-mode operations; the HTTP base path is the
// one the Better Auth router routes on (the pathname of the instance's `baseURL`), not an option.
/**
 * FSL-127: in Feishu mode Better Auth serves only `/feishu-login/request`, `/feishu-login/verify`,
 * `/get-session` and `/sign-out`. Every other operation — email/password sign-up and sign-in,
 * social sign-in, the admin plugin's endpoints, the old `/enterprise/*`, and any endpoint a later
 * plugin adds — is rejected, both over HTTP and when server code calls `auth.api.*` directly.
 *
 * HTTP: `onRequest` (this plugin is registered first, so it runs before every other plugin's
 * `onRequest` and before the router matches a route) compares the request pathname, exactly as the
 * WHATWG URL parser yields it and the router routes on it (percent-encoding is not decoded), with
 * `<base path><operation>` for the four operations. A trailing slash, a repeated slash, a
 * percent-encoded character or a different letter case — in the operation or in the base path —
 * is not one of the four and answers 404 `{ "error": "NOT_FOUND" }` with `Cache-Control: no-store`.
 *
 * Direct calls: a `before` hook matched on every endpoint compares the endpoint's own path, so an
 * `auth.api.*` call to any other endpoint throws `APIError` `NOT_FOUND` before its handler runs.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

import { FEISHU_LOGIN_REQUEST_PATH, FEISHU_LOGIN_VERIFY_PATH } from "./plugin";

export const FEISHU_LOGIN_OPERATION_POLICY_ID = "megaui-feishu-login-operation-policy";

/** The only Better Auth operations reachable in Feishu mode. */
export const FEISHU_LOGIN_AUTH_OPERATIONS = Object.freeze([
  FEISHU_LOGIN_REQUEST_PATH,
  FEISHU_LOGIN_VERIFY_PATH,
  "/get-session",
  "/sign-out",
] as const);

export type FeishuLoginAuthOperation = (typeof FEISHU_LOGIN_AUTH_OPERATIONS)[number];

const ALLOWED_OPERATIONS: ReadonlySet<string> = new Set<string>(FEISHU_LOGIN_AUTH_OPERATIONS);

/** The HTTP answer of a rejected operation. */
export const FEISHU_LOGIN_OPERATION_DENIED_BODY = Object.freeze({ error: "NOT_FOUND" } as const);
/** The `APIError` message of a rejected direct `auth.api.*` call. */
export const FEISHU_LOGIN_OPERATION_DENIED_MESSAGE = "AUTH_OPERATION_NOT_FOUND";

export function isFeishuLoginAuthOperation(path: unknown): path is FeishuLoginAuthOperation {
  return typeof path === "string" && ALLOWED_OPERATIONS.has(path);
}

function deniedResponse(): Response {
  return new Response(JSON.stringify(FEISHU_LOGIN_OPERATION_DENIED_BODY), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * The base path the Better Auth router strips (better-call `createRouter`: the `baseURL`
 * pathname without trailing slashes, `""` for `/`), or `null` when `baseURL` is not a URL.
 */
function routerBasePath(baseURL: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(baseURL).pathname;
  } catch {
    return null;
  }
  return pathname === "/" ? "" : pathname.replace(/\/+$/, "");
}

/** The operation part of the request pathname, or `null` when it is not under the base path. */
function httpOperation(request: Request, baseURL: string): string | null {
  const basePath = routerBasePath(baseURL);
  if (basePath === null) return null;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length);
}

const guardDirectOperation = createAuthMiddleware(async (ctx) => {
  if (!isFeishuLoginAuthOperation(ctx.path)) {
    throw new APIError("NOT_FOUND", { message: FEISHU_LOGIN_OPERATION_DENIED_MESSAGE });
  }
});

export function createFeishuLoginOperationPolicy(): BetterAuthPlugin {
  return {
    id: FEISHU_LOGIN_OPERATION_POLICY_ID,
    version: "1",
    onRequest: async (request, ctx) => {
      if (!isFeishuLoginAuthOperation(httpOperation(request, ctx.baseURL))) {
        return { response: deniedResponse() };
      }
    },
    hooks: {
      before: [{ matcher: () => true, handler: guardDirectOperation }],
    },
  };
}
