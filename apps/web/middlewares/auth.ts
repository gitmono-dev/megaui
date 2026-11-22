import { getTranslation, resolveApiLocale } from "@megaui/i18n";
import { NextResponse, type NextRequest } from "next/server";

import { resolveWebActor, resolveWebSessionEntry } from "../lib/enterprise-session";
import { i18n } from "../lib/i18n-config";

// megaui:apps/next-app/middlewares/authMiddleware.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-01 / DEBT-01):
// - Inverted to fail-closed: public allowlist only; unmatched routes require
//   session (pages → 302 signin, APIs → 401).
// - Stripped SaaS subscription / permission / admin branches.
// - No per-request console.log (DEBT-06).
// - API 401 message via i18n `errors.auth.unauthorized` (GC-14).

type PublicRoute = {
  pattern: RegExp;
  /** When present, only these exact HTTP methods receive the exception. */
  methods?: readonly string[];
  /** Auth pages: guests allowed; signed-in users redirect to workspace. */
  isAuthRoute?: boolean;
  /** Public only in Feishu mode (`resolveWebSessionEntry() === "feishu"`). */
  feishuOnly?: boolean;
};

const localeAlt = i18n.locales.map((l) => l.replace("-", "\\-")).join("|");

const publicRoutes: PublicRoute[] = [
  // Homepage (ADR-ARCH-09)
  { pattern: new RegExp(`^/(${localeAlt})$`, "i") },
  // Auth pages (bodies land in WA-02; middleware must still allow guests)
  {
    pattern: new RegExp(
      `^/(${localeAlt})/(signin|signup|forgot-password|reset-password)/?$`,
      "i",
    ),
    isAuthRoute: true,
  },
  // FSL-129: the Feishu email-code sign-in page is an auth page in Feishu mode
  // only; elsewhere it stays behind the session guard (the page is a 404 there).
  {
    pattern: new RegExp(`^/(${localeAlt})/signin/feishu/?$`, "i"),
    isAuthRoute: true,
    feishuOnly: true,
  },
  // Health + better-auth handler (handler route lands in WA-02)
  { pattern: /^\/api\/health$/i },
  { pattern: /^\/api\/auth(\/.*)?$/i },
  // BFF session guard lives in WA-03 route handler (returns Mega envelope 401)
  { pattern: /^\/api\/mega(\/.*)?$/i },
  // Upload handler owns its multipart-aware session guard and error contract.
  { pattern: /^\/api\/upload$/i },
  // mega2 reverse mail call — bearer auth in WA-05 route (not Better Auth)
  { pattern: /^\/api\/internal\/notifications\/email$/i },
];

// FSL-132: the deleted Feishu events callback and enterprise eligibility routes answer
// 404 to every caller, signed in or not, so a former caller (for example the Feishu
// console still posting events) learns the route is gone instead of being asked to sign in.
const retiredRoutes: readonly RegExp[] = [
  /^\/api\/integrations\/feishu\/events\/?$/i,
  /^\/api\/internal\/enterprise\/eligibility\/?$/i,
];

function rejectRetiredRoute(request: NextRequest): NextResponse | undefined {
  const pathname = request.nextUrl.pathname;
  if (!retiredRoutes.some(pattern => pattern.test(pathname))) return undefined;
  return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers: { "cache-control": "no-store" } });
}

// Next normalizes a catch-all route's trailing slash before the Better Auth
// handler sees it. Outside legacy the allowed operations are matched by exact
// path at middleware time as well, so trailing slashes, duplicate slashes and
// encoded path variants cannot become the canonical operation.
//
// FSL-126: for an AUTH_MODE / AUTH_PROVIDER pair that `resolveAuthMode`
// refuses (from FSL-132 including `maintenance` and `enterprise` without
// AUTH_PROVIDER), the anonymous Better Auth surface is only the session read
// and sign-out. `get-session`
// answers through `resolveWebActor`, so a non-Feishu session reads as null.
const invalidModeAuthOperations = new Set([
  "/get-session",
  "/sign-out",
]);

// FSL-150: Feishu mode (AUTH_MODE=enterprise, AUTH_PROVIDER=feishu) adds the two
// Feishu login endpoints, matched by exact path like every other operation.
const feishuAuthOperations = new Set([
  "/feishu-login/request",
  "/feishu-login/verify",
  "/get-session",
  "/sign-out",
]);

function allowedAuthOperations(): ReadonlySet<string> | undefined {
  const entry = resolveWebSessionEntry();
  if (entry === "feishu") return feishuAuthOperations;
  if (entry === "invalid") return invalidModeAuthOperations;
  return undefined;
}

function rejectAuthPathVariant(request: NextRequest): NextResponse | undefined {
  const allowed = allowedAuthOperations();
  if (!allowed) return undefined;
  const pathname = request.nextUrl.pathname;
  // The public route matches `/api/auth` case-insensitively, so a case variant of
  // the prefix itself is a path variant too and is refused like any other.
  const prefix = pathname.slice(0, "/api/auth/".length);
  if (prefix.toLowerCase() === "/api/auth/") {
    const operation = pathname.slice("/api/auth".length);
    if (prefix !== "/api/auth/" || !allowed.has(operation)) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
  }
  return undefined;
}

function rejectLegacyAuthPage(request: NextRequest): NextResponse | undefined {
  if (resolveWebSessionEntry() === "existing") return undefined;
  const pathname = request.nextUrl.pathname;
  if (!new RegExp(`^/(${localeAlt})/(signup|forgot-password|reset-password)/?$`, "i").test(pathname)) {
    return undefined;
  }
  return NextResponse.json({ error: "NOT_FOUND" }, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

function extractLocale(pathname: string): string {
  const segment = pathname.split("/")[1];
  if (segment && (i18n.locales as readonly string[]).includes(segment)) {
    return segment;
  }
  return i18n.defaultLocale;
}

export async function authMiddleware(
  request: NextRequest,
): Promise<NextResponse | undefined> {
  const pathname = request.nextUrl.pathname;
  const retired = rejectRetiredRoute(request);
  if (retired) return retired;
  const pathVariant = rejectAuthPathVariant(request);
  if (pathVariant) return pathVariant;
  const legacyAuthPage = rejectLegacyAuthPage(request);
  if (legacyAuthPage) return legacyAuthPage;
  const matched = publicRoutes.find(
    (route) =>
      route.pattern.test(pathname) &&
      (route.methods === undefined || route.methods.includes(request.method)) &&
      (route.feishuOnly !== true || resolveWebSessionEntry() === "feishu"),
  );

  if (matched) {
    if (matched.isAuthRoute) {
      if (await resolveWebActor(request.headers)) {
        const locale = extractLocale(pathname);
        return NextResponse.redirect(
          new URL(`/${locale}/workspace`, request.url),
          { status: 302 },
        );
      }
    }
    return undefined;
  }

  // Fail-closed: unmatched routes require auth
  if (await resolveWebActor(request.headers)) {
    return undefined;
  }

  const isApi = pathname.toLowerCase().startsWith("/api/");
  if (isApi) {
    const locale = resolveApiLocale(request);
    const message = getTranslation(locale).errors.auth.unauthorized;
    return NextResponse.json(
      { error: "unauthorized", key: "errors.auth.unauthorized", message },
      { status: 401 },
    );
  }

  const locale = extractLocale(pathname);
  const signInUrl = new URL(`/${locale}/signin`, request.url);
  signInUrl.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(signInUrl, { status: 302 });
}
