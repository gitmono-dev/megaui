// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (dispatchMega*)
//
// Diff vs upstream (GC-03 / WA-03):
// - Extensible route registry; domain handlers register in WA-04/05/06 instead
//   of a monolithic 1000-line dispatch file.
// - No E2E reset / mock-store backdoors (megaui-only).

import { MegaNotFoundError } from "@megaui/engine";

import { MegaApiInputError } from "./errors";

export type MegaHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface MegaDispatchContext {
  method: MegaHttpMethod;
  segments: readonly string[];
  searchParams: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export interface MegaRouteRegistration {
  match: (method: MegaHttpMethod, segments: readonly string[]) => boolean;
  handle: (context: MegaDispatchContext) => Promise<unknown>;
}

const routeRegistry: MegaRouteRegistration[] = [];

/** Register a BFF handler (WA-04/05/06 call this at module init). */
export function registerMegaRoute(registration: MegaRouteRegistration): void {
  routeRegistry.push(registration);
}

export async function readMegaRequestBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MegaApiInputError("Request body must be valid JSON");
  }
}

export async function dispatchMegaRequest(
  context: MegaDispatchContext,
): Promise<unknown> {
  for (const route of routeRegistry) {
    if (!route.match(context.method, context.segments)) continue;
    return route.handle(context);
  }
  throw new MegaNotFoundError(
    "Mega resource",
    context.segments.join("/") || "root",
  );
}

/** Test-only reset — not exported from barrel; used by contract tests. */
export function resetMegaRouteRegistryForTests(): void {
  routeRegistry.length = 0;
}
