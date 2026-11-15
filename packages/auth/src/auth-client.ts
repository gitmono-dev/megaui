// megaui:libs/auth/authClient.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-06 task card):
// - React client only (Vue / Nuxt parity is a permanent non-goal — DEBT-05).
// - Dropped phoneNumberClient and genericOAuthClient (no phone / wechat).
// - Kept adminClient to match the server `admin` plugin.

import { adminClient } from "better-auth/client/plugins";
import { createAuthClient as createBetterAuthClient } from "better-auth/react";

import { createEnterpriseSessionClientPlugin } from "./enterprise-otp/public-session-client";

export interface CreateAuthClientOptions {
  /** Optional absolute base URL for the auth API (defaults to same origin). */
  baseURL?: string;
}

export type EnterprisePairingRequestResult =
  | Readonly<{
      ok: true;
      pairingId: string;
      pairingToken: string;
      expiresIn: number;
      resendAfter: number;
    }>
  | Readonly<{ ok: false; error: string }>;

export type EnterprisePairingStatusResult =
  | Readonly<{ ok: true; status: "pending" | "confirmed" | "expired"; challengeId?: string }>
  | Readonly<{ ok: false; error: string }>;

export type EnterprisePairingVerifyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: string }>;

export interface EnterprisePairingClient {
  request(alias: string): Promise<EnterprisePairingRequestResult>;
  status(pairingId: string): Promise<EnterprisePairingStatusResult>;
  verify(challengeId: string, code: string): Promise<EnterprisePairingVerifyResult>;
}

async function postEnterprise<T>(
  baseURL: string | undefined,
  path: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: T | null }> {
  try {
    const response = await fetch(`${baseURL ?? ""}/api/auth/enterprise/${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const bodyValue: unknown = await response.json().catch(() => null);
    return { response, body: bodyValue as T | null };
  } catch {
    return { response: new Response(null, { status: 503 }), body: null };
  }
}

export function createEnterprisePairingClient(options: CreateAuthClientOptions = {}): EnterprisePairingClient {
  return {
    async request(alias) {
      const { response, body } = await postEnterprise<{
        pairingId?: string;
        pairingToken?: string;
        expiresIn?: number;
        resendAfter?: number;
        error?: string;
      }>(options.baseURL, "request", { alias });
      if (response.ok && body?.pairingId && body.pairingToken
        && Number.isSafeInteger(body.expiresIn) && Number.isSafeInteger(body.resendAfter)) {
        const expiresIn = body.expiresIn as number;
        const resendAfter = body.resendAfter as number;
        return { ok: true, pairingId: body.pairingId, pairingToken: body.pairingToken,
          expiresIn, resendAfter };
      }
      return { ok: false, error: body?.error ?? (response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE") };
    },
    async status(pairingId) {
      const { response, body } = await postEnterprise<{
        status?: "pending" | "confirmed" | "expired";
        challengeId?: string;
        error?: string;
      }>(options.baseURL, "status", { pairingId });
      if (response.ok && (body?.status === "pending" || body?.status === "confirmed" || body?.status === "expired")
        && (body.status !== "confirmed" || typeof body.challengeId === "string")) {
        return { ok: true, status: body.status, ...(body.challengeId ? { challengeId: body.challengeId } : {}) };
      }
      return { ok: false, error: body?.error ?? "UNAVAILABLE" };
    },
    async verify(challengeId, code) {
      const { response, body } = await postEnterprise<{ ok?: boolean; error?: string }>(
        options.baseURL, "verify", { challengeId, code },
      );
      if (response.ok && body?.ok === true) return { ok: true };
      return { ok: false, error: body?.error ?? (response.status === 401 ? "INVALID_CREDENTIALS" : "UNAVAILABLE") };
    },
  };
}

/**
 * Create a better-auth React client with the admin plugin enabled. The
 * session atom is transparently routed to the public DTO endpoint; callers
 * keep the Better Auth `useSession/getSession` surface without receiving
 * internal enterprise metadata.
 */
export function createAuthClient(options: CreateAuthClientOptions = {}) {
  const client = createBetterAuthClient({
    baseURL: options.baseURL,
    plugins: [adminClient(), createEnterpriseSessionClientPlugin()],
  });
  const enterprise = createEnterprisePairingClient(options);
  // Better Auth's client is a dynamic path Proxy.  Assigning an `enterprise`
  // property to that proxy does not affect its getter, which would interpret
  // `enterprise.request(alias)` as a generated Better Auth route and spread
  // the alias string into numeric JSON keys.  Intercept the namespace before
  // delegating all other properties to the original client.
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "enterprise") return enterprise;
      return Reflect.get(target, property, receiver);
    },
  }) as typeof client & { readonly enterprise: EnterprisePairingClient };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
