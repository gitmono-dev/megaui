// megaui:libs/auth/authClient.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-02):
// - Exports a named `authClient` singleton (not `authClientReact`) so
//   the name is framework-agnostic; callers that previously used
//   `authClientReact` in upstream map to `authClient` here.
// - `baseURL` is omitted: better-auth auto-detects the current origin
//   in the browser; SSR renders are handled server-side via `getAuth()`.
// - `adminClient()` plugin retained (PK-06 kept the `admin` better-auth
//   plugin and its schema fields).

import { createAuthClient } from "@megaui/auth/client";

export const authClient = createAuthClient();
