import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@megaui/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebActor } from "@/lib/enterprise-session";
import {
  OrionAuthzError,
  authorizeClRead,
  authorizeClWrite,
  authorizeTaskAccess,
} from "./orion-authz";

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface FakeUserRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly banned?: boolean;
}

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

const pgDialect = new PgDialect();

function createFakeMemberDb(members: readonly FakeUserRecord[]): Database {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    select(fields: Record<string, unknown>) {
      return {
        from() {
          return {
            where(expr: unknown) {
              const isCandidateQuery =
                "name" in fields && "email" in fields && !("banned" in fields);
              if (isCandidateQuery) {
                // Faithfully compile and evaluate the actual Drizzle SQL prefilter predicate
                const compiled = pgDialect.sqlToQuery(expr as SQL);
                const sqlText = compiled.sql;
                const params = compiled.params;
                const excludeId = params[0];
                const matchName = sqlText.includes('"name" = $2') ? params[1] : undefined;
                const matchEmailSub = sqlText.includes('strpos("user"."email", $3) > 0')
                  ? params[2]
                  : undefined;
                const matchFeishuId = sqlText.includes('"id" = $4') ? params[3] : undefined;

                return Promise.resolve(
                  members
                    .filter((m) => {
                      if (m.id === excludeId) return false;
                      const byName = typeof matchName === "string" && m.name === matchName;
                      const byEmail =
                        typeof matchEmailSub === "string" &&
                        m.email.includes(matchEmailSub);
                      const byFeishuId =
                        typeof matchFeishuId === "string" && m.id === matchFeishuId;
                      return byName || byEmail || byFeishuId;
                    })
                    .map((m) => ({ id: m.id, name: m.name, email: m.email })),
                );
              }
              const id = extractBoundValue(expr);
              return {
                limit() {
                  if (typeof id === "string") {
                    const row = byId.get(id);
                    if (row) {
                      return Promise.resolve([
                        {
                          id: row.id,
                          name: row.name,
                          email: row.email,
                          banned: row.banned ?? false,
                        },
                      ]);
                    }
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

function makeActor(
  userId: string,
  email?: string,
  kind: WebActor["kind"] = "legacy",
): WebActor {
  return Object.freeze({
    kind,
    userId,
    ...(email !== undefined ? { email } : {}),
    sessionId: `sess_${userId}`,
  });
}

describe("shared fail-closed Cedar resource authz guard (CLB-23)", () => {
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
  const mega2CallSpy = vi.fn();

  function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      MEGA2_PUBLIC_BASE_URL: mega2BaseUrl,
      ORION2_BASE_URL: orionBaseUrl,
      ORION2_JWT_HMAC_SECRET: TEST_SECRET,
      ORION2_ENVIRONMENT_ID: "env_prod",
      ...overrides,
    };
  }

  beforeAll(async () => {
    mega2Server = http.createServer((req, res) => {
      mega2CallSpy(req.method, req.url, req.headers.cookie);
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
    orionCallSpy.mockClear();
    mega2CallSpy.mockClear();
    mega2Handler = undefined;
    orionHandler = undefined;
  });

  it("allows read-only member on read and rejects write with 403 without calling orion2", async () => {
    const db = createFakeMemberDb([{ id: "user_reader", name: "reader", email: "reader@example.com" }]);
    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      const action = url.searchParams.get("action");
      res.setHeader("Content-Type", "application/json");
      if (action === "read") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            allowed: true,
            action: "read",
            cl_link: "cl-123",
            principal: "reader",
          }),
        );
        return;
      }
      res.statusCode = 403;
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Forbidden" }));
    };

    const headers = new Headers({ cookie: "mega_sess=reader-token" });
    const readRes = await authorizeClRead(
      makeActor("user_reader", "reader@example.com"),
      "cl-123",
      headers,
      { db, env: env() },
    );
    expect(readRes).toEqual({
      actorUserId: "user_reader",
      clLink: "cl-123",
      action: "read",
      principal: "reader",
    });

    await expect(
      authorizeClWrite(makeActor("user_reader", "reader@example.com"), "cl-123", headers, {
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_denied",
    });
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("enforces exact mega2-session principal binding for legacy, Feishu, collision, case-mismatch, and banned members", async () => {
    const db = createFakeMemberDb([
      { id: "user_alice", name: "alice_dev", email: "bob@other.example.com" },
      { id: "u_feishu_42", name: "Feishu Display", email: "feishu@corp.example.com" },
      { id: "user_banned", name: "banned", email: "banned@example.com", banned: true },
    ]);
    let returnedPrincipal = "bob";
    mega2Handler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          allowed: true,
          action: "read",
          cl_link: "cl-123",
          principal: returnedPrincipal,
        }),
      );
    };

    const headers = new Headers({ cookie: "mega_sess=session-token" });
    // Email local-part collision ("bob" from bob@other.example.com) must NOT match legacy actor whose derived principal is "alice_dev"
    await expect(
      authorizeClRead(makeActor("user_alice", "bob@other.example.com"), "cl-123", headers, {
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_mismatch",
    });

    // Case mismatch must also be rejected
    returnedPrincipal = "Alice_Dev";
    await expect(
      authorizeClRead(makeActor("user_alice", "bob@other.example.com"), "cl-123", headers, {
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_mismatch",
    });

    // Feishu actor derives exact `fs_<userId>` principal
    returnedPrincipal = "fs_u_feishu_42";
    const feishuOk = await authorizeClRead(
      makeActor("u_feishu_42", "feishu@corp.example.com", "feishu"),
      "cl-123",
      headers,
      { db, env: env() },
    );
    expect(feishuOk.principal).toBe("fs_u_feishu_42");

    returnedPrincipal = "u_feishu_42";
    await expect(
      authorizeClRead(
        makeActor("u_feishu_42", "feishu@corp.example.com", "feishu"),
        "cl-123",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_mismatch",
    });

    mega2CallSpy.mockClear();
    await expect(
      authorizeClRead(makeActor("user_banned", "banned@example.com"), "cl-123", headers, {
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_MEMBER_REQUIRED",
    });

    // All four principal-conflict paths fail closed with 403 ci_authz_principal_conflict
    // evaluated through the compiled Drizzle SQL prefilter:
    // 1) duplicate legacy name
    // 2) blank-name email local-part collision across domains
    // 3) Feishu actor colliding with legacy user named `fs_<feishuId>`
    // 4) legacy actor named `fs_<otherId>` colliding with Feishu principal of `<otherId>`
    const collisionDb = createFakeMemberDb([
      { id: "u_dup_1", name: "shared_name", email: "one@example.com" },
      { id: "u_dup_2", name: "shared_name", email: "two@example.com" },
      { id: "u_blank_1", name: "   ", email: "sam@corp-a.example.com" },
      { id: "u_blank_2", name: "", email: "sam@corp-b.example.com" },
      { id: "u_feishu_99", name: "Feishu Nine", email: "f99@corp.example.com" },
      { id: "u_legacy_spoof", name: "fs_u_feishu_99", email: "spoof@corp.example.com" },
    ]);
    await expect(
      authorizeClRead(makeActor("u_dup_1", "one@example.com"), "cl-123", headers, {
        db: collisionDb,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_conflict",
    });
    await expect(
      authorizeClRead(makeActor("u_blank_1", "sam@corp-a.example.com"), "cl-123", headers, {
        db: collisionDb,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_conflict",
    });
    await expect(
      authorizeClRead(
        makeActor("u_feishu_99", "f99@corp.example.com", "feishu"),
        "cl-123",
        headers,
        { db: collisionDb, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_conflict",
    });
    await expect(
      authorizeClRead(makeActor("u_legacy_spoof", "spoof@corp.example.com"), "cl-123", headers, {
        db: collisionDb,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_principal_conflict",
    });

    expect(mega2CallSpy).not.toHaveBeenCalled();
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("rejects non-workspace members with 403 and missing cookies with 401 before calling mega2 or orion2", async () => {
    const db = createFakeMemberDb([{ id: "user_member", name: "member", email: "member@example.com" }]);
    const headers = new Headers({ cookie: "mega_sess=outsider" });

    await expect(
      authorizeClRead(makeActor("user_outsider"), "cl-123", headers, { db, env: env() }),
    ).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_MEMBER_REQUIRED",
    });

    await expect(
      authorizeTaskAccess(
        makeActor("user_outsider"),
        { taskId: "tsk_1" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_MEMBER_REQUIRED",
    });

    // Missing cookie fails closed with 401 before any Orion2 lookup JWT is minted
    await expect(
      authorizeTaskAccess(
        makeActor("user_member", "member@example.com"),
        { taskId: "tsk_1" },
        "read",
        new Headers(),
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });

    expect(mega2CallSpy).not.toHaveBeenCalled();
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("fails closed on mega2 Cedar off/shadow (403) and unavailable store (503)", async () => {
    const db = createFakeMemberDb([{ id: "user_dev", name: "dev", email: "dev@example.com" }]);
    const headers = new Headers({ cookie: "mega_sess=dev" });

    mega2Handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_policy_not_enforced",
          message: "Cedar must be in enforce mode",
        }),
      );
    };
    await expect(
      authorizeClRead(makeActor("user_dev", "dev@example.com"), "cl-123", headers, {
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_policy_not_enforced",
    });

    mega2Handler = (_req, res) => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_unavailable",
          message: "Entity store unavailable",
        }),
      );
    };
    await expect(
      authorizeClWrite(makeActor("user_dev", "dev@example.com"), "cl-123", headers, {
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "ci_authz_unavailable",
    });
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("rejects tasks without cl_link and cross-environment/missing tasks with 403", async () => {
    const db = createFakeMemberDb([{ id: "user_dev", name: "dev", email: "dev@example.com" }]);
    const headers = new Headers({ cookie: "mega_sess=dev" });

    orionHandler = (req, res) => {
      // Verify Service JWT binds server environment_id = env_prod and lookup-only scope = task.read
      const auth = req.headers.authorization ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);
      const claims = JSON.parse(
        Buffer.from(auth.slice("Bearer ".length).split(".")[1]!, "base64url").toString("utf8"),
      ) as { environment_id: string; scope: string };
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.scope).toBe("task.read");

      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/tasks/tsk_mismatched") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_different_id",
            attempt_id: "att_different",
            status: "queued",
            targets: ["//:all"],
            source: { repo_path: "/repo", commit_sha: SHA_A, cl_link: "cl-allowed", head_revision: 1 },
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T00:00:00Z",
          }),
        );
        return;
      }
      if (req.url === "/v1/tasks/tsk_no_cl") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            task_id: "tsk_no_cl",
            attempt_id: "att_no_cl",
            status: "queued",
            targets: ["//:all"],
            source: { repo_path: "/repo", commit_sha: SHA_A },
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T00:00:00Z",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          namespace: "orion.v1",
          version: 1,
          error: { code: "not_found", message: "Task not found" },
        }),
      );
    };

    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { taskId: "tsk_mismatched" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ORION_TASK_ACCESS_DENIED",
    });

    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { taskId: "tsk_no_cl" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ORION_TASK_ACCESS_DENIED",
    });

    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { taskId: "tsk_other_env" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ORION_TASK_ACCESS_DENIED",
    });

    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { taskId: "tsk_missing" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ORION_TASK_ACCESS_DENIED",
    });

    expect(mega2CallSpy).not.toHaveBeenCalled();
  });

  it("resolves historical attempt_id via GET /v1/tasks?attempt_id= and enforces Cedar authz + environment isolation", async () => {
    const db = createFakeMemberDb([{ id: "user_dev", name: "dev", email: "dev@example.com" }]);
    const headers = new Headers({ cookie: "mega_sess=dev" });

    orionHandler = (req, res) => {
      const auth = req.headers.authorization ?? "";
      const claims = JSON.parse(
        Buffer.from(auth.slice("Bearer ".length).split(".")[1]!, "base64url").toString("utf8"),
      ) as { environment_id: string; scope: string };
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.scope).toBe("task.read");

      const url = new URL(req.url ?? "/", orionBaseUrl);
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/v1/tasks") {
        const attemptId = url.searchParams.get("attempt_id");
        if (attemptId === "att_historical_1") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              items: [
                {
                  namespace: "orion.v1",
                  version: 1,
                  task_id: "tsk_hist",
                  attempt_id: "att_latest_2",
                  matched_attempt_id: "att_historical_1",
                  status: "succeeded",
                  targets: ["//:all"],
                  source: {
                    repo_path: "/repo",
                    commit_sha: SHA_A,
                    cl_link: "cl-allowed",
                    head_revision: 2,
                  },
                  created_at: "2026-11-24T00:00:00Z",
                  updated_at: "2026-11-24T00:01:00Z",
                },
              ],
              next_cursor: null,
            }),
          );
          return;
        }
        if (attemptId === "att_forbidden_cl") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              items: [
                {
                  namespace: "orion.v1",
                  version: 1,
                  task_id: "tsk_forb",
                  attempt_id: "att_forbidden_cl",
                  matched_attempt_id: "att_forbidden_cl",
                  status: "failed",
                  targets: ["//:all"],
                  source: {
                    repo_path: "/secret",
                    commit_sha: SHA_A,
                    cl_link: "cl-secret",
                    head_revision: 1,
                  },
                  created_at: "2026-11-24T00:00:00Z",
                  updated_at: "2026-11-24T00:01:00Z",
                },
              ],
              next_cursor: null,
            }),
          );
          return;
        }
        if (attemptId === "att_cross_env") {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              items: [],
              next_cursor: null,
            }),
          );
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    };

    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/v1/cl/cl-allowed/ci-authz") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            allowed: true,
            action: url.searchParams.get("action"),
            cl_link: "cl-allowed",
            principal: "dev",
          }),
        );
        return;
      }
      res.statusCode = 403;
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Denied" }));
    };

    const ok = await authorizeTaskAccess(
      makeActor("user_dev", "dev@example.com"),
      { attemptId: "att_historical_1" },
      "read",
      headers,
      { db, env: env() },
    );
    expect(ok.taskId).toBe("tsk_hist");
    expect(ok.attemptId).toBe("att_historical_1");
    expect(ok.clLink).toBe("cl-allowed");
    expect(ok.environmentId).toBe("env_prod");
    expect(ok.principal).toBe("dev");

    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { attemptId: "att_forbidden_cl" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ci_authz_denied",
    });

    mega2CallSpy.mockClear();
    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { attemptId: "att_cross_env" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toBeInstanceOf(OrionAuthzError);
    await expect(
      authorizeTaskAccess(
        makeActor("user_dev", "dev@example.com"),
        { attemptId: "att_cross_env" },
        "read",
        headers,
        { db, env: env() },
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "ORION_TASK_ACCESS_DENIED",
    });
    expect(mega2CallSpy).not.toHaveBeenCalled();
  });
});
