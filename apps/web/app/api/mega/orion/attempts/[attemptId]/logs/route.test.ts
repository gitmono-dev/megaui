import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { user, type Database } from "@megaui/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertMegaFailureEnvelope } from "@/lib/adapter/envelope";
import type { WebActor } from "@/lib/enterprise-session";
import { SseAuthRevokedError } from "./sse-proxy";

let activeFakeDb: Database;
let activeActor: WebActor | null = null;

vi.mock("@megaui/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@megaui/database")>();
  return {
    ...actual,
    getDb: () => activeFakeDb,
  };
});

vi.mock("@/lib/enterprise-session", () => ({
  resolveWebActor: async () => activeActor,
}));

const { GET: streamAttemptLogs } = await import("./route");

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pgDialect = new PgDialect();
const decoder = new TextDecoder();

function extractBoundValue(expr: unknown): unknown {
  if (!expr || typeof expr !== "object") return undefined;
  const chunks = (expr as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (const chunk of chunks) {
    if (
      chunk &&
      typeof chunk === "object" &&
      "value" in chunk &&
      !Array.isArray((chunk as { value: unknown }).value)
    ) {
      return (chunk as { value: unknown }).value;
    }
  }
  return undefined;
}

function createFakeMemberDb(
  members: readonly { id: string; name: string; email: string }[],
): Database {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    select(fields: Record<string, unknown>) {
      return {
        from(table: unknown) {
          return {
            where(expr: unknown) {
              if (table === user) {
                const isCandidateQuery =
                  "name" in fields && "email" in fields && !("banned" in fields);
                if (isCandidateQuery) {
                  const compiled = pgDialect.sqlToQuery(expr as SQL);
                  const excludeId = compiled.params[0];
                  const matchName = compiled.sql.includes('"name" = $2')
                    ? compiled.params[1]
                    : undefined;
                  return Promise.resolve(
                    members
                      .filter((m) => m.id !== excludeId && m.name === matchName)
                      .map((m) => ({ id: m.id, name: m.name, email: m.email })),
                  );
                }
                const id = extractBoundValue(expr);
                return {
                  limit() {
                    if (typeof id === "string") {
                      const row = byId.get(id);
                      if (row) return Promise.resolve([{ ...row, banned: false }]);
                    }
                    return Promise.resolve([]);
                  },
                };
              }
              return { limit: () => Promise.resolve([]) };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function makeActor(userId: string, email: string): WebActor {
  return Object.freeze({
    kind: "legacy" as const,
    userId,
    email,
    sessionId: `sess_${userId}`,
  });
}

function decodeJwtClaims(authHeader: string | undefined): {
  scope: string;
  environment_id: string;
  nbf: number;
  exp: number;
} {
  const token = (authHeader ?? "").slice("Bearer ".length);
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  ) as { scope: string; environment_id: string; nbf: number; exp: number };
}

function assertNoCredentialsInHeaders(headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    expect(name.toLowerCase()).not.toBe("authorization");
    expect(value).not.toContain(TEST_SECRET);
    expect(value).not.toContain("eyJ");
  }
}

describe("GET /api/mega/orion/attempts/[attemptId]/logs (CLB-32)", () => {
  let mega2Server: http.Server;
  let mega2BaseUrl: string;
  let mega2Handler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => void)
    | undefined;

  let orionServer: http.Server;
  let orionBaseUrl: string;
  let orionHandler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => void)
    | undefined;

  const openSockets = new Set<http.ServerResponse>();
  const orionCallSpy = vi.fn();

  const envKeys = [
    "MEGA2_PUBLIC_BASE_URL",
    "ORION2_BASE_URL",
    "ORION2_JWT_HMAC_SECRET",
    "ORION2_ENVIRONMENT_ID",
    "ORION2_SSE_RECHECK_INTERVAL_MS",
    "ORION2_SSE_RECHECK_TIMEOUT_MS",
    "ORION2_SSE_TEARDOWN_TIMEOUT_MS",
    "ORION2_SSE_MAX_DURATION_MS",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    mega2Server = http.createServer((req, res) => {
      if (mega2Handler) {
        mega2Handler(req, res);
        return;
      }
      res.statusCode = 500;
      res.end("no mega2 handler");
    });
    orionServer = http.createServer((req, res) => {
      orionCallSpy(req.method, req.url, req.headers.authorization);
      if (orionHandler) {
        orionHandler(req, res);
        return;
      }
      res.statusCode = 500;
      res.end("no orion handler");
    });

    await Promise.all([
      new Promise<void>((resolve) => mega2Server.listen(0, "127.0.0.1", () => resolve())),
      new Promise<void>((resolve) => orionServer.listen(0, "127.0.0.1", () => resolve())),
    ]);
    mega2BaseUrl = `http://127.0.0.1:${(mega2Server.address() as AddressInfo).port}`;
    orionBaseUrl = `http://127.0.0.1:${(orionServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const res of openSockets) {
      res.end();
    }
    openSockets.clear();
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        mega2Server.close((err) => (err ? reject(err) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        orionServer.close((err) => (err ? reject(err) : resolve())),
      ),
    ]);
  });

  beforeEach(() => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.MEGA2_PUBLIC_BASE_URL = mega2BaseUrl;
    process.env.ORION2_BASE_URL = orionBaseUrl;
    process.env.ORION2_JWT_HMAC_SECRET = TEST_SECRET;
    process.env.ORION2_ENVIRONMENT_ID = "env_prod";
    process.env.ORION2_SSE_RECHECK_INTERVAL_MS = "1000";
    process.env.ORION2_SSE_RECHECK_TIMEOUT_MS = "500";
    process.env.ORION2_SSE_TEARDOWN_TIMEOUT_MS = "200";
    process.env.ORION2_SSE_MAX_DURATION_MS = "10000";

    activeFakeDb = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);
    activeActor = makeActor("u_dev", "dev@example.com");
    orionCallSpy.mockClear();
    mega2Handler = undefined;
    orionHandler = undefined;
  });

  afterEach(() => {
    for (const res of openSockets) {
      res.end();
    }
    openSockets.clear();
    for (const key of envKeys) {
      const prev = savedEnv.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("rejects unconfigured (503), cross-site (403), unauthenticated (401), and invalid attemptId/query/header (400) with zero Orion2 calls", async () => {
    delete process.env.ORION2_BASE_URL;
    const uncfg = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_1/logs"),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(uncfg.status).toBe(503);
    assertNoCredentialsInHeaders(uncfg.headers);
    const uncfgJson: unknown = await uncfg.json();
    assertMegaFailureEnvelope(uncfgJson);
    expect(uncfgJson.error.code).toBe("ORION2_UNCONFIGURED");

    process.env.ORION2_BASE_URL = orionBaseUrl;
    const crossSite = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_1/logs", {
        headers: { "sec-fetch-site": "cross-site", cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(crossSite.status).toBe(403);
    assertNoCredentialsInHeaders(crossSite.headers);

    activeActor = null;
    const unauth = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_1/logs"),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(unauth.status).toBe(401);

    activeActor = makeActor("u_dev", "dev@example.com");
    const badId = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/bad..id/logs", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "bad..id" }) },
    );
    expect(badId.status).toBe(400);

    const badQuery = await streamAttemptLogs(
      new Request(
        "https://mega.example.com/api/mega/orion/attempts/att_1/logs?environment_id=other",
        { headers: { cookie: "mega_sess=dev" } },
      ),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(badQuery.status).toBe(400);

    const badAfter = await streamAttemptLogs(
      new Request(
        "https://mega.example.com/api/mega/orion/attempts/att_1/logs?after=%0A41",
        { headers: { cookie: "mega_sess=dev" } },
      ),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(badAfter.status).toBe(400);

    const badLastEventId = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_1/logs", {
        headers: { cookie: "mega_sess=dev", "last-event-id": "bad id with space" },
      }),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(badLastEventId.status).toBe(400);

    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("enforces pre-connect Cedar viewRepo across historical attempts, forwards Last-Event-ID with 60s log.read JWT, and sets SSE headers", async () => {
    const attempts = new Map<
      string,
      { readonly envId: string; readonly latestAttemptId: string; readonly clLink?: string }
    >([
      ["att_hist_1", { envId: "env_prod", latestAttemptId: "att_latest_2", clLink: "cl-ok" }],
      ["att_denied", { envId: "env_prod", latestAttemptId: "att_denied", clLink: "cl-denied" }],
      ["att_shadow", { envId: "env_prod", latestAttemptId: "att_shadow", clLink: "cl-shadow" }],
      ["att_unavail", { envId: "env_prod", latestAttemptId: "att_unavail", clLink: "cl-unavail" }],
      ["att_nocl", { envId: "env_prod", latestAttemptId: "att_nocl" }],
      ["att_other_env", { envId: "env_other", latestAttemptId: "att_other_env", clLink: "cl-ok" }],
    ]);

    const logStreamCalls: Array<{
      readonly url: string;
      readonly lastEventId: string | undefined;
      readonly scope: string;
    }> = [];

    orionHandler = (req, res) => {
      const claims = decodeJwtClaims(req.headers.authorization);
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.exp - claims.nbf).toBe(60);

      const url = new URL(req.url!, orionBaseUrl);
      if (url.pathname === "/v1/tasks") {
        expect(claims.scope).toBe("task.read");
        const attemptId = url.searchParams.get("attempt_id") ?? "";
        const rec = attempts.get(attemptId);
        res.setHeader("Content-Type", "application/json");
        if (!rec || rec.envId !== claims.environment_id) {
          res.statusCode = 200;
          res.end(
            JSON.stringify({ namespace: "orion.v1", version: 1, items: [], next_cursor: null }),
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                task_id: "tsk_1",
                attempt_id: rec.latestAttemptId,
                matched_attempt_id: attemptId,
                status: "running",
                targets: ["//:"],
                source: rec.clLink
                  ? { repo_path: "/repo", commit_sha: SHA_A, cl_link: rec.clLink, head_revision: 1 }
                  : { repo_path: "/repo", commit_sha: SHA_A },
                created_at: "2026-11-24T10:00:00Z",
                updated_at: "2026-11-24T10:01:00Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }

      if (url.pathname === "/v1/attempts/att_hist_1/logs") {
        expect(claims.scope).toBe("log.read");
        logStreamCalls.push({
          url: url.pathname + url.search,
          lastEventId: req.headers["last-event-id"] as string | undefined,
          scope: claims.scope,
        });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write("id: 42\ndata: buck2 build ok\n\n");
        res.end();
        return;
      }

      res.statusCode = 404;
      res.end();
    };

    mega2Handler = (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/api/v1/cl/cl-ok/ci-authz?action=read")) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({ allowed: true, action: "read", cl_link: "cl-ok", principal: "dev" }),
        );
        return;
      }
      if (req.url?.startsWith("/api/v1/cl/cl-shadow/ci-authz")) {
        res.statusCode = 403;
        res.end(JSON.stringify({ code: "ci_authz_policy_not_enforced", message: "Shadow" }));
        return;
      }
      if (req.url?.startsWith("/api/v1/cl/cl-unavail/ci-authz")) {
        res.statusCode = 503;
        res.end(JSON.stringify({ code: "ci_authz_unavailable", message: "Down" }));
        return;
      }
      res.statusCode = 403;
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Denied" }));
    };

    // Denied, shadow, missing cl_link, cross-env, unknown -> uniform 403, ZERO /logs calls
    const denied = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_denied/logs", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_denied" }) },
    );
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();

    for (const id of ["att_shadow", "att_nocl", "att_other_env", "att_unknown"]) {
      const res = await streamAttemptLogs(
        new Request(`https://mega.example.com/api/mega/orion/attempts/${id}/logs`, {
          headers: { cookie: "mega_sess=dev" },
        }),
        { params: Promise.resolve({ attemptId: id }) },
      );
      expect(res.status, `expected 403 for ${id}`).toBe(403);
      expect(await res.text()).toBe(deniedBody);
    }

    const unavail = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_unavail/logs", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_unavail" }) },
    );
    expect(unavail.status).toBe(503);
    expect(logStreamCalls).toHaveLength(0);

    // Allowed historical attempt streams with Last-Event-ID + 60s log.read JWT + SSE headers
    const ok = await streamAttemptLogs(
      new Request(
        "https://mega.example.com/api/mega/orion/attempts/att_hist_1/logs?after=41",
        {
          headers: {
            cookie: "mega_sess=dev",
            "last-event-id": "41",
          },
        },
      ),
      { params: Promise.resolve({ attemptId: "att_hist_1" }) },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/event-stream");
    expect(ok.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(ok.headers.get("x-accel-buffering")).toBe("no");
    assertNoCredentialsInHeaders(ok.headers);

    const streamedText = await ok.text();
    expect(streamedText).toBe("id: 42\ndata: buck2 build ok\n\n");
    expect(streamedText).not.toContain(TEST_SECRET);
    expect(streamedText).not.toContain("eyJ");
    expect(logStreamCalls).toEqual([
      { url: "/v1/attempts/att_hist_1/logs?after=41", lastEventId: "41", scope: "log.read" },
    ]);
  });

  it("aborts upstream and terminates SSE mid-stream when session logs out OR Cedar viewRepo is revoked", async () => {
    let cedarAllowed = true;
    let upstreamAbortedCount = 0;

    orionHandler = (req, res) => {
      const url = new URL(req.url!, orionBaseUrl);
      if (url.pathname === "/v1/tasks") {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                task_id: "tsk_live",
                attempt_id: "att_live",
                matched_attempt_id: "att_live",
                status: "running",
                targets: ["//:"],
                source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-live", head_revision: 1 },
                created_at: "2026-11-24T10:00:00Z",
                updated_at: "2026-11-24T10:01:00Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }

      if (url.pathname === "/v1/attempts/att_live/logs") {
        openSockets.add(res);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("id: 1\ndata: live-line-1\n\n");
        req.on("close", () => {
          upstreamAbortedCount += 1;
          openSockets.delete(res);
        });
        return;
      }

      res.statusCode = 404;
      res.end();
    };

    mega2Handler = (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (cedarAllowed) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({ allowed: true, action: "read", cl_link: "cl-live", principal: "dev" }),
        );
      } else {
        res.statusCode = 403;
        res.end(JSON.stringify({ code: "ci_authz_denied", message: "Revoked" }));
      }
    };

    // Case 1: Session logout mid-stream terminates stream on next 1s recheck
    const res1 = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_live/logs", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_live" }) },
    );
    expect(res1.status).toBe(200);
    const reader1 = res1.body!.getReader();
    const chunk1 = await reader1.read();
    expect(decoder.decode(chunk1.value)).toBe("id: 1\ndata: live-line-1\n\n");

    // Simulate user logout
    activeActor = null;
    await expect(reader1.read()).rejects.toBeInstanceOf(SseAuthRevokedError);

    // Case 2: Cedar viewRepo revoked mid-stream terminates stream on next 1s recheck
    activeActor = makeActor("u_dev", "dev@example.com");
    cedarAllowed = true;
    const res2 = await streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_live/logs", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_live" }) },
    );
    expect(res2.status).toBe(200);
    const reader2 = res2.body!.getReader();
    const chunk2 = await reader2.read();
    expect(decoder.decode(chunk2.value)).toBe("id: 1\ndata: live-line-1\n\n");

    // Simulate Cedar revocation in mega2
    cedarAllowed = false;
    await expect(reader2.read()).rejects.toBeInstanceOf(SseAuthRevokedError);

    // Give sockets a tick to observe close
    await new Promise((r) => setTimeout(r, 50));
    expect(upstreamAbortedCount).toBeGreaterThanOrEqual(2);
  });

  it("propagates client abort during upstream connect before response headers arrive", async () => {
    let connectClosed = false;
    let connectStartedResolve: (() => void) | undefined;
    const connectStarted = new Promise<void>((resolve) => {
      connectStartedResolve = resolve;
    });

    orionHandler = (req, res) => {
      const url = new URL(req.url!, orionBaseUrl);
      if (url.pathname === "/v1/tasks") {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                task_id: "tsk_slow",
                attempt_id: "att_slow",
                matched_attempt_id: "att_slow",
                status: "running",
                targets: ["//:"],
                source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-slow", head_revision: 1 },
                created_at: "2026-11-24T10:00:00Z",
                updated_at: "2026-11-24T10:01:00Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }

      if (url.pathname === "/v1/attempts/att_slow/logs") {
        openSockets.add(res);
        connectStartedResolve?.();
        req.on("close", () => {
          connectClosed = true;
          openSockets.delete(res);
        });
        // Intentionally delay headers until client aborts
        return;
      }

      res.statusCode = 404;
      res.end();
    };

    mega2Handler = (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(
        JSON.stringify({ allowed: true, action: "read", cl_link: "cl-slow", principal: "dev" }),
      );
    };

    const clientController = new AbortController();
    const pendingRes = streamAttemptLogs(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_slow/logs", {
        headers: { cookie: "mega_sess=dev" },
        signal: clientController.signal,
      }),
      { params: Promise.resolve({ attemptId: "att_slow" }) },
    );

    await connectStarted;
    clientController.abort();
    const res = await pendingRes;
    expect(res.status).toBe(499);
    await new Promise((r) => setTimeout(r, 50));
    expect(connectClosed).toBe(true);
  });
});
