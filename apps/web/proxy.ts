// megaui-only: Next proxy entry point (Node.js runtime).
//
// Each request goes through, in order:
//   1. static-file bypass
//   2. locale redirect  (adds the `/{locale}` prefix to page URLs)
//   3. fail-closed auth (see ./middlewares/auth)
// The first step that produces a response wins; otherwise the request continues.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authMiddleware } from "./middlewares/auth";
import { localeMiddleware } from "./middlewares/locale";

/** Paths under these prefixes are framework or public assets and need no checks. */
const ASSET_PREFIX = /^\/(_next|images)\//i;
const FILE_EXTENSION = /\.[a-zA-Z0-9]+$/;

/**
 * A request is a plain static asset only when it targets an asset prefix, or
 * ends in a file extension AND is not an API route. API paths (matched
 * case-insensitively, because Next may serve `/API/...` too) must always reach
 * locale and auth handling so that no endpoint can be skipped by its name.
 */
function isStaticAsset(pathname: string): boolean {
  if (ASSET_PREFIX.test(pathname)) return true;
  if (pathname.toLowerCase().startsWith("/api/")) return false;
  return FILE_EXTENSION.test(pathname);
}

type Step = (request: NextRequest) => NextResponse | undefined | Promise<NextResponse | undefined>;

const STEPS: readonly Step[] = [localeMiddleware, authMiddleware];

export async function proxy(request: NextRequest) {
  if (isStaticAsset(request.nextUrl.pathname)) return NextResponse.next();

  for (const step of STEPS) {
    const response = await step(request);
    if (response) return response;
  }
  return NextResponse.next();
}
