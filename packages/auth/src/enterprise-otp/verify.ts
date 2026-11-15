// megaui-only (FS-14): Better Auth internal-adapter session creation.
import { setSessionCookie } from "better-auth/cookies";
import type { EnterpriseOtpGrant } from "./types";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
type BetterAuthEndpointContext = Parameters<typeof setSessionCookie>[0];

export interface EnterpriseOtpSessionResult {
  readonly session: Record<string, unknown>;
  readonly user: Record<string, unknown>;
  readonly created: boolean;
}

function customGrantId(session: unknown): unknown {
  if (!session || typeof session !== "object" || Array.isArray(session)) return undefined;
  return Reflect.get(session, "enterpriseGrantId");
}

async function findExistingGrantSession(ctx: BetterAuthEndpointContext, grantId: string, userId: string): Promise<Record<string, unknown> | null> {
  const sessions = await ctx.context.internalAdapter.listSessions(userId);
  const match = sessions.find((session) => customGrantId(session) === grantId);
  return match ? match as unknown as Record<string, unknown> : null;
}

/** Creates a server session through Better Auth's real internal adapter. */
export async function createEnterpriseSession(
  ctx: BetterAuthEndpointContext,
  grant: EnterpriseOtpGrant,
): Promise<EnterpriseOtpSessionResult> {
  const user = await ctx.context.internalAdapter.findUserById(grant.localUserId);
  if (!user) throw new Error("ENTERPRISE_VERIFY_UNAVAILABLE");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const override = {
    expiresAt,
    enterpriseGrantId: grant.grantId,
    enterpriseIdentityId: grant.identityId,
    authEpoch: grant.authEpoch,
    authMethod: "enterprise",
  };
  let session: Record<string, unknown>;
  let created = false;
  try {
    session = await ctx.context.internalAdapter.createSession(grant.localUserId, false, override, true) as unknown as Record<string, unknown>;
    created = true;
  } catch {
    // The grant unique index is the race arbiter; read back the winner.
    const existing = await findExistingGrantSession(ctx, grant.grantId, grant.localUserId);
    if (!existing) throw new Error("ENTERPRISE_VERIFY_UNAVAILABLE");
    session = existing;
  }
  try {
    await setSessionCookie(ctx, { session: session as never, user }, false, { maxAge: SESSION_TTL_MS / 1000 });
  } catch (error) {
    if (created) {
      try {
        const token = Reflect.get(session, "token");
        if (typeof token === "string" && token.length > 0) await ctx.context.internalAdapter.deleteSession(token);
      } catch { /* do not expose adapter cleanup details */ }
    }
    throw error;
  }
  return { session, user: user as unknown as Record<string, unknown>, created };
}

export const ENTERPRISE_SESSION_TTL_MS = SESSION_TTL_MS;
