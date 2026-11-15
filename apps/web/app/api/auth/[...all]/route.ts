// megaui:apps/next-app/app/api/auth/[...all]/route.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-02):
// - Defers `getAuth()` to request time (WA-01 lazy singleton): the handler
//   wrappers below only resolve the auth instance when a request arrives,
//   so build-time page-data collection (`next build`, including the Docker
//   builder stage that runs without runtime env) never touches the GC-07
//   fail-closed runtime secrets in `getRuntimeSecrets()`.
// - No extra CORS headers — trusted origins are wired in `getAuth()` via
//   `resolveAuthTrustedOrigins` (PK-06).

import { AUTH_ROUTE_PREFIX, toNextJsHandler } from "@megaui/auth";

import { getAuth } from "@/lib/auth";
import { getMega2SessionResponse } from "@/lib/mega2-session";

const { GET: authGET, POST: authPOST } = toNextJsHandler({
  handler: (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== AUTH_ROUTE_PREFIX && !pathname.startsWith(`${AUTH_ROUTE_PREFIX}/`)) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    return getAuth().handler(request);
  },
});

async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === `${AUTH_ROUTE_PREFIX}/get-session`) {
    return getMega2SessionResponse(request);
  }
  return authGET(request);
}

async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === `${AUTH_ROUTE_PREFIX}/get-session`) {
    return getMega2SessionResponse(request);
  }
  return authPOST(request);
}

export { GET, POST };
