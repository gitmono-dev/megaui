// megaui-only (FS-39): public enterprise session projection isolated from internal session data.
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { createAuthEndpoint, getSession } from "better-auth/api";
import type { EnterpriseOperationMode } from "./policy";

export interface EnterprisePublicSessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}
export interface EnterprisePublicSession {
  readonly session: Readonly<{
    readonly id: string;
    readonly expiresAt: Date;
  }>;
  readonly user: EnterprisePublicSessionUser;
}

export interface EnterpriseSessionAuthority {
  readonly localUserId: string;
  readonly identityId: string;
  readonly authEpoch: number;
  readonly authMethod: string;
  readonly enterpriseGrantId: string;
}

export interface EnterpriseSessionLookup {
  readonly sessionId: string;
  readonly userId: string;
}

export interface EnterprisePublicProfile {
  readonly localUserId: string;
  readonly displayName: string | null;
  readonly notificationEmail: string | null;
}

export interface EnterpriseSessionPluginOptions {
  readonly resolveMode: () => Promise<EnterpriseOperationMode>;
  readonly readEnterpriseAuthority: (
    lookup: EnterpriseSessionLookup,
  ) => Promise<EnterpriseSessionAuthority | null>;
  readonly readEnterpriseProfile: (
    authority: EnterpriseSessionAuthority,
  ) => Promise<EnterprisePublicProfile | null>;
  readonly qualifyEnterprise: (
    authority: EnterpriseSessionAuthority,
  ) => Promise<boolean>;
}

type RecordLike = Record<string, unknown>;
type SessionResult = { readonly response?: unknown; readonly headers: Headers };

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function date(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function publicSession(
  response: RecordLike,
  profile?: EnterprisePublicProfile,
): EnterprisePublicSession | null {
  const responseSession = record(response.session);
  const responseUser = record(response.user);
  if (!responseSession || !responseUser || !text(responseSession.id)
    || !date(responseSession.expiresAt) || !text(responseUser.id)) return null;
  if (profile && profile.localUserId !== responseUser.id) return null;
  const name = profile ? profile.displayName ?? "" : (text(responseUser.name) ? responseUser.name : "");
  const email = profile ? profile.notificationEmail ?? "" : (text(responseUser.email) ? responseUser.email : "");
  const image = responseUser.image === null || responseUser.image === undefined || text(responseUser.image)
    ? (text(responseUser.image) ? responseUser.image : null)
    : null;
  return Object.freeze({
    session: Object.freeze({ id: responseSession.id, expiresAt: responseSession.expiresAt }),
    user: Object.freeze({ id: responseUser.id, name, email, image }),
  });
}

async function readSessionResponse(ctx: RecordLike): Promise<RecordLike | null> {
  const result = await getSession()({
    ...ctx,
    method: "GET",
    asResponse: false,
    headers: ctx.headers,
    returnHeaders: true,
    query: { disableCookieCache: true, disableRefresh: true },
  } as never).catch(() => null) as SessionResult | null;
  if (!result?.response) return null;
  const setCookie = ctx.setCookie as (...args: readonly unknown[]) => void;
  const setHeader = ctx.setHeader as (...args: readonly unknown[]) => void;
  for (const cookie of result.headers.getSetCookie()) {
    parseSetCookieHeader(cookie).forEach((attrs, name) => setCookie(name, attrs.value, toCookieOptions(attrs)));
  }
  result.headers.delete("set-cookie");
  result.headers.forEach((value: string, key: string) => setHeader(key, value));
  return record(result.response);
}

/** Server plugin for the non-sensitive public session projection. */
export function createEnterpriseSessionPlugin(options: EnterpriseSessionPluginOptions) {
  if (!options || typeof options.resolveMode !== "function"
    || typeof options.readEnterpriseAuthority !== "function"
    || typeof options.readEnterpriseProfile !== "function"
    || typeof options.qualifyEnterprise !== "function") {
    throw new Error("INVALID_ENTERPRISE_SESSION_PLUGIN_CONFIG");
  }
  return {
    id: "megaui-enterprise-public-session",
    version: "1",
    endpoints: {
      getEnterpriseSession: createAuthEndpoint("/enterprise/session", {
        method: "GET",
        requireHeaders: true,
      }, async (ctx) => {
        const mode = await options.resolveMode().catch(() => "reject" as const);
        if (mode === "reject" || mode === "maintenance") return ctx.json(null);
        const response = await readSessionResponse(ctx as unknown as RecordLike);
        if (!response) return ctx.json(null);
        if (mode === "legacy") return ctx.json(publicSession(response));

        const responseSession = record(response.session);
        const responseUser = record(response.user);
        if (!responseSession || !responseUser || !text(responseSession.id) || !text(responseUser.id)) return ctx.json(null);
        const sessionAuthority = await options.readEnterpriseAuthority({
          sessionId: responseSession.id,
          userId: responseUser.id,
        }).catch(() => null);
        if (!sessionAuthority || sessionAuthority.authMethod !== "enterprise" || !responseUser
          || sessionAuthority.localUserId !== responseUser.id) return ctx.json(null);
        if (!(await options.qualifyEnterprise(sessionAuthority).catch(() => false))) return ctx.json(null);
        const profile = await options.readEnterpriseProfile(sessionAuthority).catch(() => null);
        if (!profile) return ctx.json(null);
        return ctx.json(publicSession(response, profile));
      }),
    },
  };
}
