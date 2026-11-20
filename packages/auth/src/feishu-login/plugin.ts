// megaui:packages/auth/src/enterprise-otp/plugin.ts@24a8551 (megaui-only FSL-123, FSL-124: the feishuLogin Better Auth plugin)
/**
 * FSL-123, FSL-124: the `feishuLogin` Better Auth plugin (ADR-FSL-11 「入口」「请求」「校验」).
 *
 * It adds `POST /feishu-login/request` (`/api/auth/feishu-login/request` under the web mount),
 * whose contract lives in `request.ts`, and — only when the `verify` option is passed —
 * `POST /feishu-login/verify`, whose contract lives in `verify.ts`. `createAuth` registers the plugin only
 * when it receives the `feishuLogin` option; the web wiring is FSL-150, so no deployment
 * exposes the endpoint before that card. Better Auth's own per-address rate limit (production
 * only) keeps applying to admissible requests with its default window and maximum; `createAuth`
 * only routes the path through `feishuLoginRequestRateLimitRule`, which exempts invalid inputs
 * so they answer 400 before any 429 (ADR-FSL-11 response order). `onRequest` answers every
 * inadmissible request (including a body over 4 KiB) 400 before the framework parses its body.
 *
 * The verify path has no custom rate-limit rule: Better Auth's per-address limit (production
 * only, default window and maximum) counts every verify request, malformed ones included, and its
 * 429 comes before anything the plugin answers. `onRequest` then answers a malformed verify body
 * (another media type, over 4 KiB, not JSON, not exactly `{ "code": <8 characters> }`) 400 before
 * the framework parses it; only an admissible one reaches the endpoint, which answers 401 or 200.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";

import {
  admitFeishuLoginRequest,
  precheckFeishuLoginHttpRequest,
  scheduleFeishuLoginIssue,
  type FeishuLoginIssuePort,
  type FeishuLoginRequestLogKey,
} from "./request";
import {
  precheckFeishuLoginVerifyHttpRequest,
  readFeishuLoginVerifyOptions,
  verifyFeishuLoginCode,
  type FeishuLoginVerifyOptions,
} from "./verify";

export const FEISHU_LOGIN_PLUGIN_ID = "megaui-feishu-login";
export const FEISHU_LOGIN_REQUEST_PATH = "/feishu-login/request";
export const FEISHU_LOGIN_VERIFY_PATH = "/feishu-login/verify";

export interface FeishuLoginPluginOptions {
  /** The issue service; called after the 202 has been answered (FSL-150 injects the engine's). */
  readonly issue: FeishuLoginIssuePort;
  /** Receives stable log keys only. Defaults to `console.warn`. */
  readonly log?: (key: FeishuLoginRequestLogKey) => void;
  /**
   * FSL-124: the database pool, `FEISHU_APP_ID` and `ENTERPRISE_OTP_HMAC_KEY` of the verify
   * endpoint. `POST /feishu-login/verify` is registered only when this is passed (FSL-150 wires it).
   */
  readonly verify?: FeishuLoginVerifyOptions;
}

type SchemaIssue = Readonly<{ readonly message: string; readonly path: readonly (string | number)[] }>;
type AnyBodySchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: unknown }
      | { readonly issues: readonly SchemaIssue[] };
  };
};

// The endpoint answers every malformed body with its own 400 `INVALID_INPUT`, so the schema
// hands the parsed body through untouched and `admitFeishuLoginRequest` decides.
const passThroughBody = {
  "~standard": {
    version: 1 as const,
    vendor: "megaui",
    validate(value: unknown) {
      return { value };
    },
  },
} satisfies AnyBodySchema;

interface RateLimitRule {
  readonly window: number;
  readonly max: number;
}

/**
 * The Better Auth `rateLimit.customRules` entry of `FEISHU_LOGIN_REQUEST_PATH`: an admissible
 * request keeps the rule Better Auth resolved (the default per-address window and maximum); an
 * invalid input, including a body over 4 KiB, is not counted and not limited, and the plugin's
 * `onRequest` answers it 400 `INVALID_INPUT`.
 */
export async function feishuLoginRequestRateLimitRule(
  request: Request,
  currentRule: RateLimitRule,
): Promise<RateLimitRule | false> {
  return (await precheckFeishuLoginHttpRequest(request)) === "admissible" ? currentRule : false;
}

function invalidInputResponse(): Response {
  return new Response(JSON.stringify({ code: "INVALID_INPUT" }), {
    status: 400,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function isPostTo(request: Request, baseURL: string, path: string): boolean {
  if (request.method !== "POST") return false;
  try {
    const basePath = new URL(baseURL).pathname.replace(/\/+$/, "");
    return new URL(request.url).pathname === `${basePath}${path}`;
  } catch {
    return false;
  }
}

function defaultLog(key: FeishuLoginRequestLogKey): void {
  console.warn(key);
}

export function feishuLogin(options: FeishuLoginPluginOptions): BetterAuthPlugin {
  if (!options || typeof options.issue !== "function") {
    throw new Error("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
  }
  const issue = options.issue;
  const log = options.log ?? defaultLog;
  const verify = options.verify === undefined ? undefined : readFeishuLoginVerifyOptions(options.verify);
  return {
    id: FEISHU_LOGIN_PLUGIN_ID,
    version: "1",
    // Runs after Better Auth's limiter and before the framework parses the body, in every
    // environment: only an admissible request (a JSON body of at most 4 KiB with a valid email)
    // reaches the endpoint. Anything else — another media type, a body over 4 KiB (reading stops at
    // the chunk that crosses 4 KiB), malformed JSON, an invalid email — answers 400 here, so no request body is
    // ever read in full unless it passed the bounded check. The limiter's rule exempts exactly
    // these requests, so the 400 also comes ahead of any 429.
    async onRequest(request, ctx) {
      if (isPostTo(request, ctx.baseURL, FEISHU_LOGIN_REQUEST_PATH)) {
        if ((await precheckFeishuLoginHttpRequest(request)) === "admissible") return;
        return { response: invalidInputResponse() };
      }
      // The verify path gets the same bounded check against its own body shape; it is only
      // registered (and only checked) when the verify option was passed.
      if (verify !== undefined && isPostTo(request, ctx.baseURL, FEISHU_LOGIN_VERIFY_PATH)) {
        if ((await precheckFeishuLoginVerifyHttpRequest(request)) === "admissible") return;
        return { response: invalidInputResponse() };
      }
    },
    endpoints: {
      feishuLoginRequest: createAuthEndpoint(FEISHU_LOGIN_REQUEST_PATH, {
        method: "POST",
        body: passThroughBody,
      }, async (ctx) => {
        ctx.setHeader("cache-control", "no-store");
        const headers = ctx.request?.headers ?? ctx.headers;
        const outcome = admitFeishuLoginRequest(ctx.body, headers?.get("cookie"), headers?.get("content-type"));
        if (outcome.status === 400) {
          ctx.setStatus(400);
          return ctx.json(outcome.body);
        }
        const { cookie } = outcome;
        ctx.setCookie(cookie.name, cookie.value, {
          path: cookie.path,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
          maxAge: cookie.maxAge,
        });
        // Scheduled, not started: the port runs after this response has been handed back.
        scheduleFeishuLoginIssue(issue, outcome.issue, log);
        ctx.setStatus(202);
        return ctx.json(outcome.body);
      }),
      ...(verify === undefined
        ? {}
        : {
            feishuLoginVerify: createAuthEndpoint(FEISHU_LOGIN_VERIFY_PATH, {
              method: "POST",
              body: passThroughBody,
            }, async (ctx) => {
              ctx.setHeader("cache-control", "no-store");
              const headers = ctx.request?.headers ?? ctx.headers;
              const outcome = await verifyFeishuLoginCode(
                ctx,
                verify,
                ctx.body,
                headers?.get("cookie"),
                headers?.get("content-type"),
              );
              ctx.setStatus(outcome.status);
              return ctx.json(outcome.body);
            }),
          }),
    },
  };
}
