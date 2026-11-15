// megaui:apps/next-app/app/api/mega/[...segments]/route.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-03 / DEBT-03):
// - Session guard + dispatch + error mapping live in DIR-03 adapter modules.
// - Agent SSE streaming deferred to WA-06.
// - No test reset backdoor routes.

import { NextResponse } from "next/server";

import "@/lib/adapter/handlers/register";
import { maybeHandleAgentStreamPost } from "@/lib/adapter/handlers/agent-stream";
import {
  dispatchMegaRequest,
  readMegaRequestBody,
} from "@/lib/adapter/dispatch";
import {
  megaFailureResponse,
  megaSuccessResponse,
} from "@/lib/adapter/envelope";
import {
  mapMegaErrorToHttpResponse,
  unauthorizedMegaResponse,
} from "@/lib/adapter/errors";
import { resolveWebActor } from "@/lib/enterprise-session";

interface MegaRouteContext {
  params: Promise<{ segments: string[] }>;
}

async function requireMegaSession(
  request: Request,
): Promise<NextResponse | undefined> {
  if (await resolveWebActor(request.headers)) return undefined;
  const { status, body } = unauthorizedMegaResponse(request);
  return megaFailureResponse(body, status);
}

export async function GET(request: Request, context: MegaRouteContext) {
  const unauthenticated = await requireMegaSession(request);
  if (unauthenticated) return unauthenticated;

  try {
    const { segments } = await context.params;
    const data = await dispatchMegaRequest({
      method: "GET",
      segments,
      searchParams: new URL(request.url).searchParams,
      body: undefined,
      headers: request.headers,
    });
    return megaSuccessResponse(data);
  } catch (error) {
    const { status, body } = mapMegaErrorToHttpResponse(error, request);
    return megaFailureResponse(body, status);
  }
}

export async function POST(request: Request, context: MegaRouteContext) {
  const unauthenticated = await requireMegaSession(request);
  if (unauthenticated) return unauthenticated;

  try {
    const [{ segments }, body] = await Promise.all([
      context.params,
      readMegaRequestBody(request),
    ]);
    const streamResponse = await maybeHandleAgentStreamPost(request, segments, body);
    if (streamResponse) return streamResponse;
    const data = await dispatchMegaRequest({
      method: "POST",
      segments,
      searchParams: new URL(request.url).searchParams,
      body,
      headers: request.headers,
    });
    return megaSuccessResponse(data);
  } catch (error) {
    const { status, body } = mapMegaErrorToHttpResponse(error, request);
    return megaFailureResponse(body, status);
  }
}

export async function PUT(request: Request, context: MegaRouteContext) {
  const unauthenticated = await requireMegaSession(request);
  if (unauthenticated) return unauthenticated;

  try {
    const [{ segments }, body] = await Promise.all([
      context.params,
      readMegaRequestBody(request),
    ]);
    const data = await dispatchMegaRequest({
      method: "PUT",
      segments,
      searchParams: new URL(request.url).searchParams,
      body,
      headers: request.headers,
    });
    return megaSuccessResponse(data);
  } catch (error) {
    const { status, body } = mapMegaErrorToHttpResponse(error, request);
    return megaFailureResponse(body, status);
  }
}

export async function DELETE(request: Request, context: MegaRouteContext) {
  const unauthenticated = await requireMegaSession(request);
  if (unauthenticated) return unauthenticated;

  try {
    const { segments } = await context.params;
    const data = await dispatchMegaRequest({
      method: "DELETE",
      segments,
      searchParams: new URL(request.url).searchParams,
      body: undefined,
      headers: request.headers,
    });
    return megaSuccessResponse(data);
  } catch (error) {
    const { status, body } = mapMegaErrorToHttpResponse(error, request);
    return megaFailureResponse(body, status);
  }
}
