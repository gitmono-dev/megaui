import { NextResponse } from "next/server";
import {
  isValidOrionId,
  openAttemptLogStream,
} from "@megaui/engine/services/orion2";

import { CSRF_ORIGIN_REJECTED_CODE } from "@/lib/adapter/csrf";
import { authorizeClRead, authorizeTaskAccess } from "@/lib/adapter/orion-authz";
import { resolveWebActor } from "@/lib/enterprise-session";
import {
  ORION2_UNCONFIGURED_CODE,
  mapOrionRouteError,
  orionFailureResponse,
  requireConfiguredOrion2,
  requireOrionActor,
  validateSingleQueryParams,
} from "../../../shared";
import {
  SseProxyConfigError,
  createGuardedSseStream,
  parseSseProxyConfig,
  type SseProxyConfig,
} from "./sse-proxy";

export const dynamic = "force-dynamic";

const ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set(["after"]);
const SAFE_EVENT_ID_RE = /^[^\u0000-\u001f\u007f\s]{1,128}$/;

interface AttemptLogsRouteContext {
  readonly params: Promise<{ readonly attemptId: string }>;
}

function parseOptionalEventToken(raw: string | null): {
  readonly ok: boolean;
  readonly value?: string;
} {
  if (raw === null) return { ok: true };
  if (!SAFE_EVENT_ID_RE.test(raw)) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

/**
 * `GET /api/mega/orion/attempts/[attemptId]/logs` (`CLB-32` / `ADR-CLB-05`):
 * Streams Orion2 attempt build logs via SSE with pre-connect and continuous
 * backpressure-decoupled authorization rechecks (both authoritative Postgres
 * `resolveWebActor` AND enforced `mega2` Cedar `viewRepo` via `authorizeClRead`).
 */
export async function GET(
  request: Request,
  context: AttemptLogsRouteContext,
): Promise<Response> {
  const configured = requireConfiguredOrion2();
  if (!configured.ok) return configured.response;

  let sseConfig: SseProxyConfig;
  try {
    sseConfig = parseSseProxyConfig();
  } catch (error) {
    if (error instanceof SseProxyConfigError) {
      return orionFailureResponse(
        503,
        ORION2_UNCONFIGURED_CODE,
        "errors.mega.internal",
        "Orion2 SSE proxy configuration is invalid",
      );
    }
    throw error;
  }

  const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return orionFailureResponse(
      403,
      CSRF_ORIGIN_REJECTED_CODE,
      "errors.mega.forbidden",
      "Cross-site event stream request rejected",
    );
  }

  const actorResult = await requireOrionActor(request);
  if (!actorResult.ok) return actorResult.response;

  const { attemptId } = await context.params;
  if (!isValidOrionId(attemptId)) {
    return orionFailureResponse(
      400,
      "INVALID_ORION_ID",
      "errors.mega.badRequest",
      "Invalid Orion attempt identifier",
    );
  }

  const { searchParams } = new URL(request.url);
  const queryCheck = validateSingleQueryParams(searchParams, ALLOWED_QUERY_KEYS);
  if (!queryCheck.ok) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      queryCheck.message,
    );
  }

  const afterParsed = parseOptionalEventToken(searchParams.get("after"));
  if (!afterParsed.ok) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "Invalid after query parameter",
    );
  }

  const lastEventIdParsed = parseOptionalEventToken(
    request.headers.get("last-event-id"),
  );
  if (!lastEventIdParsed.ok) {
    return orionFailureResponse(
      400,
      "BAD_REQUEST",
      "errors.mega.badRequest",
      "Invalid Last-Event-ID header",
    );
  }

  const initialActor = actorResult.actor;

  let authz;
  try {
    authz = await authorizeTaskAccess(
      initialActor,
      { attemptId },
      "read",
      request.headers,
      { signal: request.signal },
    );
  } catch (error) {
    return mapOrionRouteError(error, request);
  }

  if (request.signal.aborted) {
    return new NextResponse(null, {
      status: 499,
      headers: { "cache-control": "no-store" },
    });
  }

  const upstreamAbort = new AbortController();
  const forwardConnectAbort = () => upstreamAbort.abort(request.signal.reason);
  request.signal.addEventListener("abort", forwardConnectAbort, { once: true });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await openAttemptLogStream(attemptId, {
      config: configured.config,
      signal: upstreamAbort.signal,
      ...(afterParsed.value !== undefined ? { after: afterParsed.value } : {}),
      ...(lastEventIdParsed.value !== undefined
        ? { lastEventId: lastEventIdParsed.value }
        : {}),
    });
  } catch (error) {
    request.signal.removeEventListener("abort", forwardConnectAbort);
    upstreamAbort.abort();
    if (request.signal.aborted) {
      return new NextResponse(null, {
        status: 499,
        headers: { "cache-control": "no-store" },
      });
    }
    return mapOrionRouteError(error, request);
  }
  request.signal.removeEventListener("abort", forwardConnectAbort);

  if (request.signal.aborted) {
    upstreamAbort.abort(request.signal.reason);
    void upstreamResponse.body?.cancel("client_abort").catch(() => {});
    return new NextResponse(null, {
      status: 499,
      headers: { "cache-control": "no-store" },
    });
  }

  if (!upstreamResponse.body) {
    upstreamAbort.abort();
    return orionFailureResponse(
      503,
      "ORION_UPSTREAM_UNAVAILABLE",
      "errors.mega.internal",
      "Orion2 log stream body unavailable",
    );
  }

  const clLink = authz.clLink;
  const guardedStream = createGuardedSseStream({
    upstreamBody: upstreamResponse.body,
    upstreamAbort,
    config: sseConfig,
    clientSignal: request.signal,
    recheckAuth: async (signal) => {
      const currentActor = await resolveWebActor(request.headers);
      if (
        !currentActor ||
        currentActor.userId !== initialActor.userId ||
        currentActor.sessionId !== initialActor.sessionId ||
        currentActor.kind !== initialActor.kind
      ) {
        return false;
      }
      try {
        await authorizeClRead(currentActor, clLink, request.headers, {
          signal,
          timeoutMs: sseConfig.recheckTimeoutMs,
        });
        return true;
      } catch {
        return false;
      }
    },
  });

  return new Response(guardedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
