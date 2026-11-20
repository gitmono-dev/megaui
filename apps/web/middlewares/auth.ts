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
  // Health + better-auth handler (handler route lands in WA-02)
  { pattern: /^\/api\/health$/i },
  { pattern: /^\/api\/auth(\/.*)?$/i },
  // BFF session guard lives in WA-03 route handler (returns Mega envelope 401)
  { pattern: /^\/api\/mega(\/.*)?$/i },
  // Owned Next lifecycle probes used by the enterprise runtime contract test.
  { pattern: /^\/api\/owned-runtime(-pages)?$/i },
  // Upload handler owns its multipart-aware session guard and error contract.
  { pattern: /^\/api\/upload$/i },
  // mega2 reverse mail call — bearer auth in WA-05 route (not Better Auth)
  { pattern: /^\/api\/internal\/notifications\/email$/i },
  // Enterprise collab introspection — its route owns the independent service key.
  { pattern: /^\/api\/internal\/enterprise\/eligibility$/i, methods: ["POST"] },
  // Feishu callback verification owns this one exact anonymous POST boundary.
  {
    pattern: /^\/api\/integrations\/feishu\/events$/,
    methods: ["POST"],
  },
];

// Next normalizes a catch-all route's trailing slash before the Better Auth
// handler sees it. Keep the structural enterprise path check at middleware
// time as well, so `/enterprise/request/`, duplicate slashes, and encoded
// path variants cannot become the canonical operation.
const enterpriseAuthOperations = new Set([
  "/enterprise/request",
  "/enterprise/status",
  "/enterprise/verify",
  "/enterprise/session",
  "/get-session",
  "/sign-out",
]);

// FSL-126: in Feishu mode (and for an AUTH_MODE / AUTH_PROVIDER pair that
// `resolveAuthMode` refuses) the anonymous Better Auth surface is only the
// session read and sign-out; the old enterprise operations are not exposed.
// `get-session` answers through `resolveWebActor`, so a non-Feishu session
// reads as null there.
const feishuAuthOperations = new Set([
  "/get-session",
  "/sign-out",
]);

function allowedAuthOperations(): ReadonlySet<string> | undefined {
  if (resolveWebSessionEntry() !== "existing") return feishuAuthOperations;
  const mode = process.env.AUTH_MODE?.trim() ?? "legacy";
  if (mode !== "enterprise" && mode !== "maintenance") return undefined;
  return enterpriseAuthOperations;
}

function rejectEnterpriseAuthPathVariant(request: NextRequest): NextResponse | undefined {
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
  if (resolveWebSessionEntry() === "existing"
    && (process.env.AUTH_MODE?.trim() ?? "legacy") !== "enterprise") return undefined;
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
  const pathVariant = rejectEnterpriseAuthPathVariant(request);
  if (pathVariant) return pathVariant;
  const legacyAuthPage = rejectLegacyAuthPage(request);
  if (legacyAuthPage) return legacyAuthPage;
  const matched = publicRoutes.find(
    (route) =>
      route.pattern.test(pathname) &&
      (route.methods === undefined || route.methods.includes(request.method)),
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
