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

const { POST: retryTaskPost } = await import("./route");

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
  members: readonly { id: string; name: string; email: string; banned?: boolean }[],
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
                      if (row) return Promise.resolve([{ ...row, banned: row.banned ?? false }]);
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

describe("POST /api/mega/orion/tasks/[taskId]/retry (CLB-29)", () => {
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

  it("enforces CSRF (403), config (503), auth (401), taskId/query/Idempotency-Key (400) with zero Orion2 calls", async () => {
    // Missing Origin -> 403 CSRF_ORIGIN_REJECTED
    const noOrigin = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/retry`, {
        method: "POST",
        headers: { cookie: "mega_sess=dev", "idempotency-key": "retry-k1" },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(noOrigin.status).toBe(403);
    const { json: csrfJson } = await readAndAssertSafeResponse(noOrigin);
    assertMegaFailureEnvelope(csrfJson);
    expect(csrfJson.error.code).toBe("CSRF_ORIGIN_REJECTED");

    // Cross-site Origin -> 403 CSRF_ORIGIN_REJECTED
    const crossOrigin = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/retry`, {
        method: "POST",
        headers: {
          origin: "https://evil.example.com",
          cookie: "mega_sess=dev",
          "idempotency-key": "retry-k1",
        },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(crossOrigin.status).toBe(403);
    await readAndAssertSafeResponse(crossOrigin);

    // Unconfigured Orion2 -> 503 ORION2_UNCONFIGURED
    delete process.env.ORION2_BASE_URL;
    const uncfg = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/retry`, {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          cookie: "mega_sess=dev",
          "idempotency-key": "retry-k1",
        },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(uncfg.status).toBe(503);
    const { json: uncfgBody } = await readAndAssertSafeResponse(uncfg);
    assertMegaFailureEnvelope(uncfgBody);
    expect(uncfgBody.error.code).toBe("ORION2_UNCONFIGURED");

    // Unauthenticated -> 401
    process.env.ORION2_BASE_URL = orionBaseUrl;
    activeActor = null;
    const unauth = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/retry`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "idempotency-key": "retry-k1" },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(unauth.status).toBe(401);
    await readAndAssertSafeResponse(unauth);

    // Invalid taskId / unexpected query / missing or malformed Idempotency-Key -> 400
    activeActor = makeActor("u_dev", "dev@example.com");
    const badId = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/bad..id/retry`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev", "idempotency-key": "retry-k1" },
      }),
      { params: Promise.resolve({ taskId: "bad..id" }) },
    );
    expect(badId.status).toBe(400);
    await readAndAssertSafeResponse(badId);

    const badQuery = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/retry?environment_id=other`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev", "idempotency-key": "retry-k1" },
      }),
      { params: Promise.resolve({ taskId: "tsk_1" }) },
    );
    expect(badQuery.status).toBe(400);
    await readAndAssertSafeResponse(badQuery);

    for (const badKey of [undefined, "", "bad..key", "key1, key2"]) {
      const headers = new Headers({ origin: TEST_ORIGIN, cookie: "mega_sess=dev" });
      if (badKey !== undefined) headers.set("idempotency-key", badKey);
      const missingKey = await retryTaskPost(
        new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_1/retry`, {
          method: "POST",
          headers,
        }),
        { params: Promise.resolve({ taskId: "tsk_1" }) },
      );
      expect(missingKey.status).toBe(400);
      const { json } = await readAndAssertSafeResponse(missingKey);
      assertMegaFailureEnvelope(json);
      expect(json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }

    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("enforces Cedar editMergeRequest (write), forwards Idempotency-Key with 60s task.write JWT, and passes through 409 stale_head_revision", async () => {
    const tasks = new Map<
      string,
      { readonly envId: string; readonly clLink?: string; readonly stale?: boolean; readonly arbitraryConflict?: boolean }
    >([
      ["tsk_ok", { envId: "env_prod", clLink: "cl-ok" }],
      ["tsk_stale", { envId: "env_prod", clLink: "cl-ok", stale: true }],
      ["tsk_weird_409", { envId: "env_prod", clLink: "cl-ok", arbitraryConflict: true }],
      ["tsk_shadow", { envId: "env_prod", clLink: "cl-shadow" }],
      ["tsk_unavail", { envId: "env_prod", clLink: "cl-unavail" }],
      ["tsk_nocl", { envId: "env_prod" }],
      ["tsk_other_env", { envId: "env_other", clLink: "cl-ok" }],
    ]);

    const writeRetryCalls: Array<{
      readonly url: string;
      readonly idempotencyKey: string | undefined;
      readonly scope: string;
    }> = [];

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
            status: "failed",
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
        const match = /^\/v1\/tasks\/([^/]+)\/retry$/.exec(req.url ?? "");
        const taskId = match ? decodeURIComponent(match[1]!) : "";
        writeRetryCalls.push({
          url: req.url ?? "",
          idempotencyKey: req.headers["idempotency-key"] as string | undefined,
          scope: claims.scope,
        });
        const rec = tasks.get(taskId);
        if (rec?.stale) {
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              error: { code: "stale_head_revision", message: "head_revision superseded" },
            }),
          );
          return;
        }
        if (rec?.arbitraryConflict) {
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              error: { code: `leaked_${TEST_SECRET}`, message: "raw error" },
            }),
          );
          return;
        }
        res.statusCode = 202;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            task_id: taskId,
            attempt_id: "att_2",
            status: "accepted",
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
      // Verify ONLY action=write (Cedar editMergeRequest) is probed
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
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Read-only user denied write" }));
    };

    // Read-only user -> 403, ZERO task.write calls
    activeActor = makeActor("u_ro", "ro@example.com");
    const roDenied = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_ok/retry`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=ro", "idempotency-key": "retry-ro" },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(roDenied.status).toBe(403);
    const { text: deniedText } = await readAndAssertSafeResponse(roDenied);

    // Non-member -> uniform 403, ZERO Orion2 calls at all
    orionCallSpy.mockClear();
    activeActor = makeActor("u_outsider", "outsider@example.com");
    const outsider = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_ok/retry`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=out", "idempotency-key": "retry-out" },
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
      const res = await retryTaskPost(
        new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/${deniedId}/retry`, {
          method: "POST",
          headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev", "idempotency-key": "retry-k" },
        }),
        { params: Promise.resolve({ taskId: deniedId }) },
      );
      expect(res.status, `expected 403 for ${deniedId}`).toBe(403);
      const { text } = await readAndAssertSafeResponse(res);
      expect(text, `expected uniform 403 body for ${deniedId}`).toBe(deniedText);
    }

    // mega2 unavailable -> 503
    const unavail = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_unavail/retry`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie: "mega_sess=dev", "idempotency-key": "retry-k" },
      }),
      { params: Promise.resolve({ taskId: "tsk_unavail" }) },
    );
    expect(unavail.status).toBe(503);
    await readAndAssertSafeResponse(unavail);

    expect(writeRetryCalls).toHaveLength(0);

    // Authorized dev -> forwards Idempotency-Key with 60s task.write JWT
    const ok = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_ok/retry`, {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          cookie: "mega_sess=dev",
          "idempotency-key": "retry-stable-123",
        },
      }),
      { params: Promise.resolve({ taskId: "tsk_ok" }) },
    );
    expect(ok.status).toBe(200);
    const { json: okJson } = await readAndAssertSafeResponse(ok);
    assertMegaSuccessEnvelope(okJson);
    expect(okJson.data).toMatchObject({ task_id: "tsk_ok", attempt_id: "att_2", status: "accepted" });

    // 409 stale_head_revision transparent passthrough
    const stale = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_stale/retry`, {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          cookie: "mega_sess=dev",
          "idempotency-key": "retry-stale-1",
        },
      }),
      { params: Promise.resolve({ taskId: "tsk_stale" }) },
    );
    expect(stale.status).toBe(409);
    const { json: staleJson } = await readAndAssertSafeResponse(stale);
    assertMegaFailureEnvelope(staleJson);
    expect(staleJson.error.code).toBe("stale_head_revision");

    // Unallowlisted 409 code sanitized (zero secret leakage)
    const weird = await retryTaskPost(
      new Request(`${TEST_ORIGIN}/api/mega/orion/tasks/tsk_weird_409/retry`, {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          cookie: "mega_sess=dev",
          "idempotency-key": "retry-weird-1",
        },
      }),
      { params: Promise.resolve({ taskId: "tsk_weird_409" }) },
    );
    expect(weird.status).toBe(409);
    const { json: weirdJson } = await readAndAssertSafeResponse(weird);
    assertMegaFailureEnvelope(weirdJson);
    expect(weirdJson.error.code).toBe("ORION_TASK_CONFLICT");

    expect(writeRetryCalls).toEqual([
      { url: "/v1/tasks/tsk_ok/retry", idempotencyKey: "retry-stable-123", scope: "task.write" },
      { url: "/v1/tasks/tsk_stale/retry", idempotencyKey: "retry-stale-1", scope: "task.write" },
      { url: "/v1/tasks/tsk_weird_409/retry", idempotencyKey: "retry-weird-1", scope: "task.write" },
    ]);
  });
});
