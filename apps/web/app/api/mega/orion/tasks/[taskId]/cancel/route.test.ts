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

const { POST: cancelTaskPost } = await import("./route");

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_ORIGIN = "https://mega.example.com";
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

describe("POST /api/mega/orion/tasks/[taskId]/cancel (CLB-30)", () => {
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
    "APP_BASE_URL",
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
    process.env.APP_BASE_URL = TEST_ORIGIN;
    process.env.MEGA2_PUBLIC_BASE_URL = mega2BaseUrl;
    process.env.ORION2_BASE_URL = orionBaseUrl;
    process.env.ORION2_JWT_HMAC_SECRET = TEST_SECRET;
    process.env.ORION2_ENVIRONMENT_ID = "env_prod";

    activeFakeDb = createFakeMemberDb([
      { id: "u_dev", name: "dev", email: "dev@example.com" },
      { id: "u_ro", name: "readonly", email: "ro@example.com" },
    ]);
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

  it("enforces CSRF (403), config (503), auth (401), and taskId/query validation (400) with zero Orion2 calls", async () => {
    const noOrigin = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/cancel`, {
        method: "POST",
        headers: { cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(noOrigin.status).toBe(403);
    const { json: csrfJson } = await readAndAssertSafeResponse(noOrigin);
    assertMegaFailureEnvelope(csrfJson);
    expect(csrfJson.error.code).toBe("CSRF_ORIGIN_REJECTED");

    const crossSite = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/cancel`, {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          "sec-fetch-site": "cross-site",
          cookie: "mega_sess=dev",
        },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(crossSite.status).toBe(403);
    await readAndAssertSafeResponse(crossSite);

    delete process.env.ORION2_BASE_URL;
    const uncfg = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(uncfg.status).toBe(503);
    const { json: uncfgBody } = await readAndAssertSafeResponse(uncfg);
    assertMegaFailureEnvelope(uncfgBody);
    expect(uncfgBody.error.code).toBe("ORION2_UNCONFIGURED");

    process.env.ORION2_BASE_URL = orionBaseUrl;
    activeActor = null;
    const unauth = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(unauth.status).toBe(401);
    await readAndAssertSafeResponse(unauth);

    activeActor = makeActor("u_dev", "dev@example.com");
    const badId = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/bad..id/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "bad..id" }) },
    );
    expect(badId.status).toBe(400);
    await readAndAssertSafeResponse(badId);

    const badQuery = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/cancel?environment_id=other`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(badQuery.status).toBe(400);
    await readAndAssertSafeResponse(badQuery);

    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("enforces Cedar editMergeRequest (write) and forwards POST /v1/tasks/{taskId}/cancel with 60s task.write JWT", async () => {
    const tasks = new Map<string, { readonly envId: string; readonly clLink?: string }>([
      ["tsk_ok", { envId: "env_prod", clLink: "cl-ok" }],
      ["tsk_shadow", { envId: "env_prod", clLink: "cl-shadow" }],
      ["tsk_unavail", { envId: "env_prod", clLink: "cl-unavail" }],
      ["tsk_nocl", { envId: "env_prod" }],
      ["tsk_other_env", { envId: "env_other", clLink: "cl-ok" }],
    ]);

    const cancelCalls: string[] = [];

    orionHandler = (req, res) => {
      const claims = decodeJwtClaims(req.headers.authorization);
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.exp - claims.nbf).toBe(60);

      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        expect(claims.scope).toBe("task.read");
        const taskId = req.url?.replace(/^\/v1\/tasks\//, "") ?? "";
        const rec = tasks.get(taskId);
        if (!rec || rec.envId !== claims.environment_id) {
          res.statusCode = 404;
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              error: { code: "not_found", message: "not found" },
            }),
          );
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            task_id: taskId,
            attempt_id: "att_1",
            status: "running",
            targets: ["//:"],
            source: rec.clLink
              ? { repo_path: "/repo", commit_sha: SHA_A, cl_link: rec.clLink, head_revision: 2 }
              : { repo_path: "/repo", commit_sha: SHA_A },
            created_at: "2026-11-24T10:00:00Z",
            updated_at: "2026-11-24T10:01:00Z",
          }),
        );
        return;
      }

      if (req.method === "POST") {
        expect(claims.scope).toBe("task.write");
        cancelCalls.push(req.url ?? "");
        const match = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(req.url ?? "");
        const taskId = match ? decodeURIComponent(match[1]!) : "";
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            task_id: taskId,
            attempt_id: "att_1",
            status: "cancelled",
          }),
        );
        return;
      }

      res.statusCode = 405;
      res.end();
    };

    mega2Handler = (req, res) => {
      res.setHeader("Content-Type", "application/json");
      const cookie = req.headers.cookie ?? "";
      expect(req.url).toContain("action=write");
      if (req.url?.startsWith("/api/v1/cl/cl-unavail/ci-authz")) {
        res.statusCode = 503;
        res.end(JSON.stringify({ code: "ci_authz_unavailable", message: "Store down" }));
        return;
      }
      if (req.url?.startsWith("/api/v1/cl/cl-shadow/ci-authz")) {
        res.statusCode = 403;
        res.end(JSON.stringify({ code: "ci_authz_policy_not_enforced", message: "Shadow" }));
        return;
      }
      if (req.url?.startsWith("/api/v1/cl/cl-ok/ci-authz") && cookie.includes("mega_sess=dev")) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({ allowed: true, action: "write", cl_link: "cl-ok", principal: "dev" }),
        );
        return;
      }
      res.statusCode = 403;
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Denied" }));
    };

    // Read-only user -> 403, ZERO cancel calls
    activeActor = makeActor("u_ro", "ro@example.com");
    const roDenied = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_ok/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=ro" },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(roDenied.status).toBe(403);
    const { text: deniedText } = await readAndAssertSafeResponse(roDenied);

    // Non-member -> uniform 403, ZERO Orion2 calls at all
    orionCallSpy.mockClear();
    activeActor = makeActor("u_outsider", "outsider@example.com");
    const outsider = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_ok/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=out" },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(outsider.status).toBe(403);
    const { text: outsiderText } = await readAndAssertSafeResponse(outsider);
    expect(outsiderText).toBe(deniedText);
    expect(orionCallSpy).not.toHaveBeenCalled();

    // Cedar off/shadow, missing cl_link, cross-env, unknown -> uniform 403
    activeActor = makeActor("u_dev", "dev@example.com");
    for (const deniedId of ["tsk_shadow", "tsk_nocl", "tsk_other_env", "tsk_unknown"]) {
      const res = await cancelTaskPost(
        new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/${deniedId}/cancel`, {
          method: "POST",
          headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev" },
        }),
        { params: Promise.resolve({ taskId: deniedId }) },
      );
      expect(res.status, `expected 403 for ${deniedId}`).toBe(403);
      const { text } = await readAndAssertSafeResponse(res);
      expect(text, `expected uniform 403 body for ${deniedId}`).toBe(deniedText);
    }

    // mega2 unavailable -> 503
    const unavail = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_unavail/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_unavail" }) },
    );
    expect(unavail.status).toBe(503);
    await readAndAssertSafeResponse(unavail);

    expect(cancelCalls).toHaveLength(0);

    // Authorized dev -> forwards POST /v1/tasks/tsk_ok/cancel with 60s task.write JWT
    const ok = await cancelTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_ok/cancel`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev" },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(ok.status).toBe(200);
    const { json: okJson } = await readAndAssertSafeResponse(ok);
    assertMegaSuccessEnvelope(okJson);
    expect(okJson.data).toMatchObject({ task_id: "tsk_ok", status: "cancelled" });
    expect(cancelCalls).toEqual(["/v1/tasks/tsk_ok/cancel"]);
  });
});
