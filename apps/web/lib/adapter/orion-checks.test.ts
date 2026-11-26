import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@megaui/database";
import { isOrion2Configured } from "@megaui/engine/services/orion2";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebActor } from "@/lib/enterprise-session";
import { mapMegaErrorToHttpResponse } from "./errors";
import { OrionAuthzError } from "./orion-authz";
import { getOrionBackedClChecks } from "./orion-checks";

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
        from() {
          return {
            where(expr: unknown) {
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
                    if (row) {
                      return Promise.resolve([
                        { id: row.id, name: row.name, email: row.email, banned: row.banned ?? false },
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

function makeActor(userId: string, email: string): WebActor {
  return Object.freeze({
    kind: "legacy" as const,
    userId,
    email,
    sessionId: `sess_${userId}`,
  });
}

describe("Orion-backed GET /api/mega/cls/[n]/checks aggregation (CLB-24)", () => {
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

  function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      MEGA2_PUBLIC_BASE_URL: mega2BaseUrl,
      ORION2_BASE_URL: orionBaseUrl,
      ORION2_JWT_HMAC_SECRET: TEST_SECRET,
      ORION2_ENVIRONMENT_ID: "env_ci",
      ...overrides,
    };
  }

  beforeAll(async () => {
    mega2Server = http.createServer((req, res) => {
      if (mega2Handler) {
        mega2Handler(req, res);
        return;
      }
      res.statusCode = 500;
      res.end("missing mega2 handler");
    });
    orionServer = http.createServer((req, res) => {
      orionCallSpy(req.method, req.url, req.headers.authorization);
      if (orionHandler) {
        orionHandler(req, res);
        return;
      }
      res.statusCode = 500;
      res.end("missing orion handler");
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
    mega2Handler = undefined;
    orionHandler = undefined;
  });

  function sendMega2Common(res: http.ServerResponse, data: unknown) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ req_result: true, data, err_message: "" }));
  }

  it("denies unauthorized or off/shadow Cedar callers with 403 and zero calls to orion2", async () => {
    const db = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);
    mega2Handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_policy_not_enforced",
          message: "Cedar enforcement must be enabled",
        }),
      );
    };

    let caught: unknown;
    try {
      await getOrionBackedClChecks({
        actor: makeActor("u_dev", "dev@example.com"),
        clLink: "cl-99",
        headers: new Headers({ cookie: "mega_sess=dev" }),
        db,
        env: env(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrionAuthzError);
    const mapped = mapMegaErrorToHttpResponse(caught);
    expect(mapped.status).toBe(403);
    expect(mapped.body.error.code).toBe("ci_authz_policy_not_enforced");
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("reports unconfigured cleanly for fallback and rejects direct call when ORION2_BASE_URL is unset", async () => {
    expect(isOrion2Configured({ NODE_ENV: "test" })).toBe(false);

    const db = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);
    mega2Handler = (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          allowed: true,
          action: "read",
          cl_link: "cl-99",
          principal: "dev",
        }),
      );
    };

    await expect(
      getOrionBackedClChecks({
        actor: makeActor("u_dev", "dev@example.com"),
        clLink: "cl-99",
        headers: new Headers({ cookie: "mega_sess=dev" }),
        db,
        env: { MEGA2_PUBLIC_BASE_URL: mega2BaseUrl },
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "ORION2_UNCONFIGURED",
    });
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("handles empty Orion2 task lists cleanly while preserving mega2 CL metadata and Merge Box CI", async () => {
    const db = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);
    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      if (url.pathname === "/api/v1/cl/cl-empty/ci-authz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            allowed: true,
            action: "read",
            cl_link: "cl-empty",
            principal: "dev",
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-empty/merge-box") {
        sendMega2Common(res, {
          merge_requirements: {
            state: "UNMERGEABLE",
            conditions: [
              {
                type: "CiStatus",
                display_name: "CI Build",
                description: "Buck2 CI",
                message: "Waiting for build",
                result: "PENDING",
                raw_status: "PENDING",
              },
            ],
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-empty/detail") {
        sendMega2Common(res, {
          id: 1,
          link: "cl-empty",
          title: "Empty CI CL",
          status: "Open",
          open_timestamp: 1_700_000_000,
          merge_timestamp: null,
          conversations: [],
          path: "/apps/demo",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 1,
          base_branch: "main",
          author: "dev",
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };

    orionHandler = (req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          namespace: "orion.v1",
          version: 1,
          items: [],
          next_cursor: null,
        }),
      );
    };

    const view = await getOrionBackedClChecks({
      actor: makeActor("u_dev", "dev@example.com"),
      clLink: "cl-empty",
      headers: new Headers({ cookie: "mega_sess=dev" }),
      db,
      env: env(),
    });

    expect(view.checks).toEqual([]);
    expect(view.pipeline).toEqual([]);
    expect(view.runner).toBe("");
    expect(view.clLink).toBe("cl-empty");
    expect(view.headCommit).toBe(SHA_B);
    expect(view.headRevision).toBe(1);
    expect(view.repoPath).toBe("/apps/demo");
    expect(view.latestTask).toBeNull();
    expect(view.tasks).toEqual([]);
    expect(view.mergeBoxCi?.result).toBe("PENDING");
  });

  it("aggregates real mega2 Merge Box + orion2 tasks and latest-attempt Buck2 targets with zero credential leakage", async () => {
    const db = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);

    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      if (url.pathname === "/api/v1/cl/cl-real/ci-authz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            allowed: true,
            action: "read",
            cl_link: "cl-real",
            principal: "dev",
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-real/merge-box") {
        sendMega2Common(res, {
          merge_requirements: {
            state: "MERGEABLE",
            conditions: [
              {
                type: "CiStatus",
                display_name: "CI Build",
                description: "Buck2 CI",
                message: "All targets passed",
                result: "PASSED",
                commit_id: SHA_B,
                head_revision: 3,
                ci_task_id: "tsk_latest",
                ci_attempt_id: "att_latest",
                raw_status: "PASSED",
              },
            ],
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-real/detail") {
        sendMega2Common(res, {
          id: 2,
          link: "cl-real",
          title: "Real Buck2 CL",
          status: "Open",
          open_timestamp: 1_700_000_000,
          merge_timestamp: null,
          conversations: [],
          path: "/services/api",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 3,
          base_branch: "main",
          author: "dev",
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };

    orionHandler = (req, res) => {
      const auth = req.headers.authorization ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);
      const claims = JSON.parse(
        Buffer.from(auth.slice("Bearer ".length).split(".")[1]!, "base64url").toString("utf8"),
      ) as { scope: string; environment_id: string };
      expect(claims.scope).toBe("task.read");
      expect(claims.environment_id).toBe("env_ci");

      const url = new URL(req.url ?? "/", orionBaseUrl);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/v1/tasks") {
        expect(url.searchParams.get("cl_link")).toBe("cl-real");
        const cursor = url.searchParams.get("cursor");
        if (!cursor) {
          res.end(
            JSON.stringify({
              namespace: "orion.v1",
              version: 1,
              items: [
                {
                  namespace: "orion.v1",
                  version: 1,
                  task_id: "tsk_latest",
                  attempt_id: "att_latest",
                  status: "succeeded",
                  targets: ["//services/api:bin", "//services/api:test"],
                  source: {
                    repo_path: "/services/api",
                    commit_sha: SHA_B,
                    cl_link: "cl-real",
                    ref_name: "refs/cl/cl-real",
                    head_revision: 3,
                  },
                  created_at: "2026-11-24T10:00:00Z",
                  updated_at: "2026-11-24T10:00:45Z",
                },
              ],
              next_cursor: "cursor_page_2",
            }),
          );
          return;
        }
        expect(cursor).toBe("cursor_page_2");
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                task_id: "tsk_prev",
                attempt_id: "att_prev",
                status: "failed",
                targets: ["//services/api:bin"],
                source: {
                  repo_path: "/services/api",
                  commit_sha: SHA_A,
                  cl_link: "cl-real",
                  ref_name: "refs/cl/cl-real",
                  head_revision: 2,
                },
                created_at: "2026-11-24T09:00:00Z",
                updated_at: "2026-11-24T09:00:30Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }
      if (url.pathname === "/v1/attempts/att_latest/targets") {
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                status_id: "st_1",
                attempt_id: "att_latest",
                task_id: "tsk_latest",
                target_path: "//services/api:bin",
                target_package: "services/api",
                target_name: "bin",
                target_configuration: "cfg",
                category: "cxx_link",
                identifier: "bin",
                action: "build",
                status: "success",
                created_at: "2026-11-24T10:00:05Z",
                updated_at: "2026-11-24T10:00:25Z",
              },
              {
                namespace: "orion.v1",
                version: 1,
                status_id: "st_2",
                attempt_id: "att_latest",
                task_id: "tsk_latest",
                target_path: "//services/api:test",
                target_package: "services/api",
                target_name: "test",
                target_configuration: "cfg",
                category: "rust_test",
                identifier: "test",
                action: "test",
                status: "failed",
                created_at: "2026-11-24T10:00:10Z",
                updated_at: "2026-11-24T10:00:40Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };

    const view = await getOrionBackedClChecks({
      actor: makeActor("u_dev", "dev@example.com"),
      clLink: "cl-real",
      headers: new Headers({ cookie: "mega_sess=dev" }),
      db,
      env: env(),
    });

    expect(view.runner).toBe("orion2");
    expect(view.clLink).toBe("cl-real");
    expect(view.headCommit).toBe(SHA_B);
    expect(view.headRevision).toBe(3);
    expect(view.repoPath).toBe("/services/api");
    expect(view.latestTask?.task_id).toBe("tsk_latest");
    expect(view.tasks).toHaveLength(2);
    expect(view.tasks?.map((t) => t.task_id)).toEqual(["tsk_latest", "tsk_prev"]);
    expect(view.mergeBoxCi?.result).toBe("PASSED");
    expect(view.checks).toEqual([
      expect.objectContaining({
        id: "st_1",
        name: "//services/api:bin",
        status: "passing",
        matrix: "cxx_link / build",
        durationSeconds: 20,
        logId: "att_latest",
      }),
      expect.objectContaining({
        id: "st_2",
        name: "//services/api:test",
        status: "failing",
        matrix: "rust_test / test",
        durationSeconds: 30,
        logId: "att_latest",
      }),
    ]);

    // Zero JWT or secret leakage in serialized response
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain("eyJ");
    expect(serialized).not.toContain("Bearer ");
  });

  it("never presents a stale revision's passing task as current-head CI and fails closed on pagination cursor loops", async () => {
    const db = createFakeMemberDb([{ id: "u_dev", name: "dev", email: "dev@example.com" }]);

    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      if (url.pathname === "/api/v1/cl/cl-stale/ci-authz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            allowed: true,
            action: "read",
            cl_link: "cl-stale",
            principal: "dev",
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-stale/merge-box") {
        sendMega2Common(res, {
          merge_requirements: {
            state: "UNMERGEABLE",
            conditions: [
              {
                type: "CiStatus",
                display_name: "CI Build",
                description: "Buck2 CI",
                message: "Pending for rev 4",
                result: "PENDING",
                head_revision: 4,
                raw_status: "PENDING",
              },
            ],
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-stale/detail") {
        sendMega2Common(res, {
          id: 3,
          link: "cl-stale",
          title: "Advanced Head CL",
          status: "Open",
          open_timestamp: 1_700_000_000,
          merge_timestamp: null,
          conversations: [],
          path: "/services/api",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 4,
          base_branch: "main",
          author: "dev",
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };

    // Only an older revision (head_revision=3) succeeded task exists in Orion2
    orionHandler = (_req, res) => {
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
              task_id: "tsk_old_rev3",
              attempt_id: "att_old_rev3",
              status: "succeeded",
              targets: ["//services/api:bin"],
              source: {
                repo_path: "/services/api",
                commit_sha: SHA_A,
                cl_link: "cl-stale",
                ref_name: "refs/cl/cl-stale",
                head_revision: 3,
              },
              created_at: "2026-11-24T10:00:00Z",
              updated_at: "2026-11-24T10:00:45Z",
            },
          ],
          next_cursor: null,
        }),
      );
    };

    const view = await getOrionBackedClChecks({
      actor: makeActor("u_dev", "dev@example.com"),
      clLink: "cl-stale",
      headers: new Headers({ cookie: "mega_sess=dev" }),
      db,
      env: env(),
    });

    expect(view.headRevision).toBe(4);
    expect(view.latestTask).toBeNull();
    expect(view.checks).toEqual([]);
    expect(view.pipeline).toEqual([]);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks?.[0]?.task_id).toBe("tsk_old_rev3");

    // Repeated cursor in target pagination fails closed with 503 instead of returning truncated targets
    orionHandler = (req, res) => {
      const url = new URL(req.url ?? "/", orionBaseUrl);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/v1/tasks") {
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            items: [
              {
                namespace: "orion.v1",
                version: 1,
                task_id: "tsk_rev4",
                attempt_id: "att_rev4",
                status: "running",
                targets: ["//services/api:bin"],
                source: {
                  repo_path: "/services/api",
                  commit_sha: SHA_B,
                  cl_link: "cl-stale",
                  ref_name: "refs/cl/cl-stale",
                  head_revision: 4,
                },
                created_at: "2026-11-24T10:00:00Z",
                updated_at: "2026-11-24T10:00:45Z",
              },
            ],
            next_cursor: null,
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          namespace: "orion.v1",
          version: 1,
          items: [],
          next_cursor: "stuck_cursor",
        }),
      );
    };

    await expect(
      getOrionBackedClChecks({
        actor: makeActor("u_dev", "dev@example.com"),
        clLink: "cl-stale",
        headers: new Headers({ cookie: "mega_sess=dev" }),
        db,
        env: env(),
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "ORION_UPSTREAM_UNAVAILABLE",
    });
  });
});
