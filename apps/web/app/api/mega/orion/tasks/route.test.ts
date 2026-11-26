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

const { GET: listTasksGet } = await import("./route");
const { GET: getTaskDetail } = await import("./[taskId]/route");

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

describe("GET /api/mega/orion/tasks and /tasks/[taskId] (CLB-26)", () => {
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

  it("returns 503 ORION2_UNCONFIGURED when ORION2_BASE_URL is unset and 401 when unauthenticated", async () => {
    delete process.env.ORION2_BASE_URL;
    const uncfgList = await listTasksGet(
      new Request("https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1"),
    );
    expect(uncfgList.status).toBe(503);
    const { json: uncfgBody } = await readAndAssertSafeResponse(uncfgList);
    assertMegaFailureEnvelope(uncfgBody);
    expect(uncfgBody.error.code).toBe("ORION2_UNCONFIGURED");

    const uncfgDetail = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_1"),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(uncfgDetail.status).toBe(503);
    const { json: uncfgDetailBody } = await readAndAssertSafeResponse(uncfgDetail);
    assertMegaFailureEnvelope(uncfgDetailBody);
    expect(uncfgDetailBody.error.code).toBe("ORION2_UNCONFIGURED");

    process.env.ORION2_BASE_URL = orionBaseUrl;
    activeActor = null;
    const unauthList = await listTasksGet(
      new Request("https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1"),
    );
    expect(unauthList.status).toBe(401);
    await readAndAssertSafeResponse(unauthList);

    const unauthDetail = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_1"),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(unauthDetail.status).toBe(401);
    await readAndAssertSafeResponse(unauthDetail);
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("validates query params & path IDs (400) and enforces Cedar viewRepo on GET /tasks (403/503/200)", async () => {
    const invalidListUrls = [
      "https://mega.example.com/api/mega/orion/tasks",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=..",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl%20bad",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&cl_link=cl-2",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&environment_id=other",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&unknown=1",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&status=bogus",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&limit=0",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&limit=101",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&limit=abc",
      "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&cursor=",
      `https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&cursor=${"c".repeat(257)}`,
    ];
    for (const url of invalidListUrls) {
      const res = await listTasksGet(
        new Request(url, { headers: { cookie: "mega_sess=dev" } }),
      );
      expect(res.status, `expected 400 for ${url}`).toBe(400);
      await readAndAssertSafeResponse(res);
    }

    const badTaskId = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/bad..id", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "bad..id" }) },
    );
    expect(badTaskId.status).toBe(400);
    await readAndAssertSafeResponse(badTaskId);

    const detailUnexpectedQuery = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_ok?environment_id=other", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(detailUnexpectedQuery.status).toBe(400);
    await readAndAssertSafeResponse(detailUnexpectedQuery);
    expect(orionCallSpy).not.toHaveBeenCalled();

    // Cedar off/shadow -> 403 and zero calls to Orion2
    mega2Handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ code: "ci_authz_policy_not_enforced", message: "Cedar shadow" }),
      );
    };
    const denied = await listTasksGet(
      new Request("https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1", {
        headers: { cookie: "mega_sess=dev" },
      }),
    );
    expect(denied.status).toBe(403);
    await readAndAssertSafeResponse(denied);
    expect(orionCallSpy).not.toHaveBeenCalled();

    // Cedar denied vs missing/inaccessible CL in mega2 (404) -> byte-for-byte identical 403
    mega2Handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Denied" }));
    };
    const cedarDeniedList = await listTasksGet(
      new Request("https://mega.example.com/api/mega/orion/tasks?cl_link=cl-denied", {
        headers: { cookie: "mega_sess=dev" },
      }),
    );
    expect(cedarDeniedList.status).toBe(403);
    const { text: cedarDeniedListText } = await readAndAssertSafeResponse(cedarDeniedList);

    mega2Handler = (_req, res) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "cl_not_found", message: "CL not found" }));
    };
    const missingClInMega2 = await listTasksGet(
      new Request("https://mega.example.com/api/mega/orion/tasks?cl_link=cl-missing", {
        headers: { cookie: "mega_sess=dev" },
      }),
    );
    expect(missingClInMega2.status).toBe(403);
    const { text: missingClListText } = await readAndAssertSafeResponse(missingClInMega2);
    expect(missingClListText).toBe(cedarDeniedListText);
    expect(orionCallSpy).not.toHaveBeenCalled();

    // mega2 unavailable -> 503 and zero calls to Orion2
    mega2Handler = (_req, res) => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "ci_authz_unavailable", message: "Store down" }));
    };
    const unavail = await listTasksGet(
      new Request("https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1", {
        headers: { cookie: "mega_sess=dev" },
      }),
    );
    expect(unavail.status).toBe(503);
    await readAndAssertSafeResponse(unavail);
    expect(orionCallSpy).not.toHaveBeenCalled();

    // Allowed -> queries Orion2 with 60s task.read JWT, forwards valid filters, leaks zero credentials
    mega2Handler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ allowed: true, action: "read", cl_link: "cl-1", principal: "dev" }),
      );
    };
    orionHandler = (req, res) => {
      const claims = decodeJwtClaims(req.headers.authorization);
      expect(claims.scope).toBe("task.read");
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.exp - claims.nbf).toBe(60);

      const url = new URL(req.url!, orionBaseUrl);
      expect(url.searchParams.get("cl_link")).toBe("cl-1");
      expect(url.searchParams.get("status")).toBe("succeeded");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("cursor")).toBe("cur_1");

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          namespace: "orion.v1",
          version: 1,
          items: [
            {
              namespace: "orion.v1",
              version: 1,
              task_id: "tsk_1",
              attempt_id: "att_1",
              status: "succeeded",
              targets: ["//:"],
              source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-1", head_revision: 1 },
              created_at: "2026-11-24T10:00:00Z",
              updated_at: "2026-11-24T10:01:00Z",
            },
          ],
          next_cursor: null,
        }),
      );
    };

    const ok = await listTasksGet(
      new Request(
        "https://mega.example.com/api/mega/orion/tasks?cl_link=cl-1&status=succeeded&limit=10&cursor=cur_1",
        { headers: { cookie: "mega_sess=dev" } },
      ),
    );
    expect(ok.status).toBe(200);
    const { json } = await readAndAssertSafeResponse(ok);
    assertMegaSuccessEnvelope(json);
  });

  it("enforces authorizeTaskAccess on GET /tasks/[taskId] (200 allowed, 403 denied/no-cl_link/cross-env/missing-cl, 503 unavailable)", async () => {
    // Environment-scoped fake Orion2 task store: verifies JWT environment_id claim isolation.
    const tasksById = new Map<
      string,
      {
        readonly environmentId: string;
        readonly payload: Record<string, unknown>;
      }
    >([
      [
        "tsk_ok",
        {
          environmentId: "env_prod",
          payload: {
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_ok",
            attempt_id: "att_ok",
            status: "running",
            targets: ["//:"],
            source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-ok", head_revision: 2 },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          },
        },
      ],
      [
        "tsk_denied_cl",
        {
          environmentId: "env_prod",
          payload: {
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_denied_cl",
            attempt_id: "att_denied",
            status: "running",
            targets: ["//:"],
            source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-denied", head_revision: 1 },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          },
        },
      ],
      [
        "tsk_missing_cl",
        {
          environmentId: "env_prod",
          payload: {
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_missing_cl",
            attempt_id: "att_missing",
            status: "running",
            targets: ["//:"],
            source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-missing", head_revision: 1 },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          },
        },
      ],
      [
        "tsk_unavail_cl",
        {
          environmentId: "env_prod",
          payload: {
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_unavail_cl",
            attempt_id: "att_unavail",
            status: "running",
            targets: ["//:"],
            source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-unavail", head_revision: 1 },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          },
        },
      ],
      [
        "tsk_nocl",
        {
          environmentId: "env_prod",
          payload: {
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_nocl",
            attempt_id: "att_nocl",
            status: "running",
            targets: ["//:"],
            source: { repo_path: "/repo", commit_sha: SHA_A },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          },
        },
      ],
      [
        "tsk_other_env",
        {
          environmentId: "env_other",
          payload: {
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_other_env",
            attempt_id: "att_other_env",
            status: "running",
            targets: ["//:"],
            source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-ok", head_revision: 1 },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          },
        },
      ],
    ]);

    const seenOrionJwtEnvs: string[] = [];
    orionHandler = (req, res) => {
      const claims = decodeJwtClaims(req.headers.authorization);
      expect(claims.scope).toBe("task.read");
      expect(claims.exp - claims.nbf).toBe(60);
      seenOrionJwtEnvs.push(claims.environment_id);

      res.setHeader("Content-Type", "application/json");
      const taskId = req.url?.replace(/^\/v1\/tasks\//, "") ?? "";
      const record = tasksById.get(taskId);
      if (record && record.environmentId === claims.environment_id) {
        res.statusCode = 200;
        res.end(JSON.stringify(record.payload));
        return;
      }
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          namespace: "orion.v1",
          version: 1,
          error: { code: "not_found", message: "not found in environment" },
        }),
      );
    };

    mega2Handler = (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/api/v1/cl/cl-ok/ci-authz")) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({ allowed: true, action: "read", cl_link: "cl-ok", principal: "dev" }),
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

    const ok = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_ok", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(ok.status).toBe(200);
    const { json: okJson } = await readAndAssertSafeResponse(ok);
    assertMegaSuccessEnvelope(okJson);
    expect(okJson.data).toMatchObject({ task_id: "tsk_ok", status: "running" });

    // Cedar denied -> 403
    const cedarDenied = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_denied_cl", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_denied_cl" }) },
    );
    expect(cedarDenied.status).toBe(403);
    const { text: cedarDeniedDetailText } = await readAndAssertSafeResponse(cedarDenied);

    // Missing CL in mega2 -> 403 byte-for-byte identical to Cedar denied (never leaks 404)
    const missingCl = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_missing_cl", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_missing_cl" }) },
    );
    expect(missingCl.status).toBe(403);
    const { text: missingClDetailText } = await readAndAssertSafeResponse(missingCl);
    expect(missingClDetailText).toBe(cedarDeniedDetailText);

    // mega2 entity store unavailable -> 503
    const megaUnavail = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_unavail_cl", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_unavail_cl" }) },
    );
    expect(megaUnavail.status).toBe(503);
    await readAndAssertSafeResponse(megaUnavail);

    // Task without cl_link -> 403
    const noCl = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_nocl", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_nocl" }) },
    );
    expect(noCl.status).toBe(403);
    await readAndAssertSafeResponse(noCl);

    // Cross-environment task exists in "env_other" with allowed cl_link "cl-ok",
    // but BFF binds JWT to server "env_prod" so Orion2 isolates it and BFF denies 403.
    const crossEnv = await getTaskDetail(
      new Request("https://mega.example.com/api/mega/orion/tasks/tsk_other_env", {
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_other_env" }) },
    );
    expect(crossEnv.status).toBe(403);
    await readAndAssertSafeResponse(crossEnv);
    expect(seenOrionJwtEnvs.every((e) => e === "env_prod")).toBe(true);
  });
});
