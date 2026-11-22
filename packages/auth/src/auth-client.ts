// megaui:libs/auth/authClient.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-06 task card):
// - React client only (Vue / Nuxt parity is a permanent non-goal — DEBT-05).
// - Dropped phoneNumberClient and genericOAuthClient (no phone / wechat).
// - Kept adminClient to match the server `admin` plugin.
// - FSL-133: no enterprise client (pairing namespace, public session route) any more.

import { adminClient } from "better-auth/client/plugins";
import { createAuthClient as createBetterAuthClient } from "better-auth/react";

export interface CreateAuthClientOptions {
  /** Optional absolute base URL for the auth API (defaults to same origin). */
  baseURL?: string;
}

/**
 * Create a better-auth React client with the admin plugin enabled. `useSession` /
 * `getSession` read Better Auth's own `/get-session`.
 */
export function createAuthClient(options: CreateAuthClientOptions = {}) {
  return createBetterAuthClient({
    baseURL: options.baseURL,
    plugins: [adminClient()],
  });
}

export type AuthClient = ReturnType<typeof createAuthClient>;
