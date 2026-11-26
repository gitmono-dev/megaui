import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { user, type Database } from "@megaui/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertMegaFailureEnvelope, assertMegaSuccessEnvelope } from "@/lib/adapter/envelope";
import type { WebActor } from "@/lib/enterprise-session";

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

const { GET: getAttemptTargets } = await import("./route");

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pgDialect = new PgDialect();

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

async function readAndAssertSafeResponse(response: Response): Promise<{
  readonly text: string;
  readonly json: unknown;
}> {
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const [headerName, headerValue] of response.headers.entries()) {
    expect(headerName.toLowerCase()).not.toBe("authorization");
    expect(headerValue).not.toContain(TEST_SECRET);
    expect(headerValue).not.toContain("eyJ");
  }
  const text = await response.text();
  expect(text).not.toContain(TEST_SECRET);
  expect(text).not.toContain("eyJ");
  return { text, json: JSON.parse(text) as unknown };
}

describe("GET /api/mega/orion/attempts/[attemptId]/targets (CLB-27)", () => {
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

  const orionCallSpy = vi.fn();

  const envKeys = [
    "MEGA2_PUBLIC_BASE_URL",
    "ORION2_BASE_URL",
    "ORION2_JWT_HMAC_SECRET",
    "ORION2_ENVIRONMENT_ID",
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

    activeFakeDb = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);
    activeActor = makeActor("u_dev", "dev@example.com");
    orionCallSpy.mockClear();
    mega2Handler = undefined;
    orionHandler = undefined;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const prev = savedEnv.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("returns 503 ORION2_UNCONFIGURED, 401 unauthenticated, and 400 invalid ID/query with zero Orion2 calls", async () => {
    delete process.env.ORION2_BASE_URL;
    const uncfg = await getAttemptTargets(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_1/targets"),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(uncfg.status).toBe(503);
    const { json: uncfgBody } = await readAndAssertSafeResponse(uncfg);
    assertMegaFailureEnvelope(uncfgBody);
    expect(uncfgBody.error.code).toBe("ORION2_UNCONFIGURED");

    process.env.ORION2_BASE_URL = orionBaseUrl;
    activeActor = null;
    const unauth = await getAttemptTargets(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_1/targets"),
      { params: Promise.resolve({ attemptId: "att_1" }) },
    );
    expect(unauth.status).toBe(401);
    await readAndAssertSafeResponse(unauth);

    activeActor = makeActor("u_dev", "dev@example.com");
    const badId = await getAttemptTargets(
      new Request("https://mega.example.com/api/mega/orion/attempts/bad..attempt/targets", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "bad..attempt" }) },
    );
    expect(badId.status).toBe(400);
    await readAndAssertSafeResponse(badId);

    const invalidQueryUrls = [
      "https://mega.example.com/api/mega/orion/attempts/att_1/targets?environment_id=other",
      "https://mega.example.com/api/mega/orion/attempts/att_1/targets?limit=0",
      "https://mega.example.com/api/mega/orion/attempts/att_1/targets?limit=101",
      "https://mega.example.com/api/mega/orion/attempts/att_1/targets?limit=10&limit=20",
      "https://mega.example.com/api/mega/orion/attempts/att_1/targets?cursor=",
      `https://mega.example.com/api/mega/orion/attempts/att_1/targets?cursor=${"c".repeat(257)}`,
    ];
    for (const url of invalidQueryUrls) {
      const res = await getAttemptTargets(
        new Request(url, { headers: { cookie: "mega_sess=dev" } }),
        { params: Promise.resolve({ attemptId: "att_1" }) },
      );
      expect(res.status, `expected 400 for ${url}`).toBe(400);
      await readAndAssertSafeResponse(res);
    }

    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("authorizes historical & latest attempts via Cedar viewRepo, isolates environments, and fails closed on denial/unavailable", async () => {
    interface StoredAttempt {
      readonly environmentId: string;
      readonly taskId: string;
      readonly latestAttemptId: string;
      readonly clLink?: string;
    }

    const attempts = new Map<string, StoredAttempt>([
      ["att_hist_1", { environmentId: "env_prod", taskId: "tsk_1", latestAttemptId: "att_latest_2", clLink: "cl-ok" }],
      ["att_latest_2", { environmentId: "env_prod", taskId: "tsk_1", latestAttemptId: "att_latest_2", clLink: "cl-ok" }],
      ["att_denied", { environmentId: "env_prod", taskId: "tsk_2", latestAttemptId: "att_denied", clLink: "cl-denied" }],
      ["att_shadow", { environmentId: "env_prod", taskId: "tsk_7", latestAttemptId: "att_shadow", clLink: "cl-shadow" }],
      ["att_missing_cl", { environmentId: "env_prod", taskId: "tsk_3", latestAttemptId: "att_missing_cl", clLink: "cl-missing" }],
      ["att_unavail", { environmentId: "env_prod", taskId: "tsk_4", latestAttemptId: "att_unavail", clLink: "cl-unavail" }],
      ["att_nocl", { environmentId: "env_prod", taskId: "tsk_5", latestAttemptId: "att_nocl" }],
      ["att_other_env", { environmentId: "env_other", taskId: "tsk_6", latestAttemptId: "att_other_env", clLink: "cl-ok" }],
    ]);

    const targetsEndpointCalls: string[] = [];
    orionHandler = (req, res) => {
      const claims = decodeJwtClaims(req.headers.authorization);
      expect(claims.scope).toBe("task.read");
      expect(claims.exp - claims.nbf).toBe(60);
      expect(claims.environment_id).toBe("env_prod");

      const url = new URL(req.url!, orionBaseUrl);
      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/v1/tasks") {
        const attemptId = url.searchParams.get("attempt_id") ?? "";
        const rec = attempts.get(attemptId);
        if (!rec || rec.environmentId !== claims.environment_id) {
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
                task_id: rec.taskId,
                attempt_id: rec.latestAttemptId,
                matched_attempt_id: attemptId,
                status: "succeeded",
                targets: ["//:app"],
                source: rec.clLink
                  ? { repo_path: "/repo", commit_sha: SHA_A, cl_link: rec.clLink, head_revision: 2 }
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

      const match = /^\/v1\/attempts\/([^/]+)\/targets$/.exec(url.pathname);
      if (match) {
        targetsEndpointCalls.push(url.pathname + url.search);
        const attemptId = decodeURIComponent(match[1]!);
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                status_id: "sts_1",
                attempt_id: attemptId,
                task_id: "tsk_1",
                target_path: "//:app",
                target_package: "//",
                target_name: "app",
                target_configuration: "cfg",
                category: "build",
                identifier: "id_1",
                action: "build",
                status: "success",
                created_at: "2026-11-24T10:00:01Z",
                updated_at: "2026-11-24T10:00:10Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ namespace: "orion.v1", version: 1, error: { code: "not_found", message: "not found" } }));
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
        res.end(
          JSON.stringify({ code: "ci_authz_policy_not_enforced", message: "Cedar shadow mode" }),
        );
        return;
      }
      if (req.url?.startsWith("/api/v1/cl/cl-missing/ci-authz")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: "cl_not_found", message: "CL not found" }));
        return;
      }
      if (req.url?.startsWith("/api/v1/cl/cl-unavail/ci-authz")) {
        res.statusCode = 503;
        res.end(JSON.stringify({ code: "ci_authz_unavailable", message: "Store down" }));
        return;
      }
      res.statusCode = 403;
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Denied" }));
    };

    // Historical attempt (superseded by att_latest_2) succeeds and forwards limit/cursor
    const histOk = await getAttemptTargets(
      new Request(
        "https://mega.example.com/api/mega/orion/attempts/att_hist_1/targets?limit=25&cursor=cur_1",
        { headers: { cookie: "mega_sess=dev" } },
      ),
      { params: Promise.resolve({ attemptId: "att_hist_1" }) },
    );
    expect(histOk.status).toBe(200);
    const { json: histJson } = await readAndAssertSafeResponse(histOk);
    assertMegaSuccessEnvelope(histJson);
    expect(histJson.data).toMatchObject({
      items: [{ attempt_id: "att_hist_1", target_path: "//:app", status: "success" }],
    });
    expect(targetsEndpointCalls).toEqual(["/v1/attempts/att_hist_1/targets?limit=25&cursor=cur_1"]);

    // Latest attempt also succeeds
    const latestOk = await getAttemptTargets(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_latest_2/targets", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_latest_2" }) },
    );
    expect(latestOk.status).toBe(200);
    const { json: latestJson } = await readAndAssertSafeResponse(latestOk);
    assertMegaSuccessEnvelope(latestJson);
    expect(latestJson.data).toMatchObject({
      items: [{ attempt_id: "att_latest_2", target_path: "//:app", status: "success" }],
    });
    expect(targetsEndpointCalls).toEqual([
      "/v1/attempts/att_hist_1/targets?limit=25&cursor=cur_1",
      "/v1/attempts/att_latest_2/targets",
    ]);

    // All authorization-denial paths (Cedar denied, Cedar off/shadow, missing CL,
    // no cl_link, cross-env, unknown) return byte-for-byte identical 403 bodies
    // and NEVER call /v1/attempts/.../targets!
    const denied = await getAttemptTargets(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_denied/targets", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_denied" }) },
    );
    expect(denied.status).toBe(403);
    const { text: deniedText } = await readAndAssertSafeResponse(denied);

    for (const deniedId of [
      "att_shadow",
      "att_missing_cl",
      "att_nocl",
      "att_other_env",
      "att_unknown",
    ]) {
      const res = await getAttemptTargets(
        new Request(`https://mega.example.com/api/mega/orion/attempts/${deniedId}/targets`, {
          headers: { cookie: "mega_sess=dev" },
        }),
        { params: Promise.resolve({ attemptId: deniedId }) },
      );
      expect(res.status, `expected 403 for ${deniedId}`).toBe(403);
      const { text } = await readAndAssertSafeResponse(res);
      expect(text, `expected uniform 403 body for ${deniedId}`).toBe(deniedText);
    }

    const unavail = await getAttemptTargets(
      new Request("https://mega.example.com/api/mega/orion/attempts/att_unavail/targets", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ attemptId: "att_unavail" }) },
    );
    expect(unavail.status).toBe(503);
    await readAndAssertSafeResponse(unavail);

    // Confirm /targets was NEVER called for any unauthorized or unavailable attempt
    expect(targetsEndpointCalls).toHaveLength(2);
  });
});
