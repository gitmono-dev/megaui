import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelTask,
  createTask,
  getTask,
  isOrion2Configured,
  listAttemptTargets,
  listTasks,
  listWorkers,
  openAttemptLogStream,
  ORION2_SERVICE_JWT_TTL_SECS,
  ORION_V1_NAMESPACE,
  ORION_V1_SCHEMA_VERSION,
  OrionClientError,
  OrionConfigError,
  resolveOrion2Config,
  retryTask,
  signOrionServiceJwt,
  verifyOrionServiceJwtSignature,
} from "./index";

const TEST_SECRET = "orion2-megaui-service-jwt-test-secret-at-least-32-bytes";
const SAMPLE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAMPLE_TS = "2026-11-24T22:00:00Z";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("@megaui/engine/services/orion2 (CLB-19)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequest: CapturedRequest | undefined;
  let nextHandler:
    | ((req: CapturedRequest, res: http.ServerResponse) => void)
    | undefined;

  function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ORION2_BASE_URL: baseUrl,
      ORION2_JWT_HMAC_SECRET: TEST_SECRET,
      ORION2_JWT_KEY_ID: "key-2026",
      ORION2_JWT_ISSUER: "https://orion.test/issuer",
      ORION2_JWT_AUDIENCE: "orion.v1.server",
      ORION2_JWT_SUBJECT: "service:megaui-bff",
      ORION2_ENVIRONMENT_ID: "env-clb19",
      ...overrides,
    };
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const captured: CapturedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        lastRequest = captured;
        if (nextHandler) {
          const handler = nextHandler;
          nextHandler = undefined;
          handler(captured, res);
          return;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            error: { code: "not_found", message: "unhandled stub route" },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("config & fail-closed validation", () => {
    it("returns false from isOrion2Configured when ORION2_BASE_URL is unset", () => {
      expect(isOrion2Configured({})).toBe(false);
      expect(isOrion2Configured({ ORION2_BASE_URL: "   " })).toBe(false);
      expect(isOrion2Configured({ ORION2_BASE_URL: "http://127.0.0.1:8080" })).toBe(true);
    });

    it("fails closed when secret is missing or shorter than 32 bytes without leaking secret", () => {
      expect(() =>
        resolveOrion2Config({ ORION2_BASE_URL: "http://127.0.0.1:8080" }),
      ).toThrow(OrionConfigError);

      const shortSecret = "too-short-secret-value";
      try {
        resolveOrion2Config({
          ORION2_BASE_URL: "http://127.0.0.1:8080",
          ORION2_JWT_HMAC_SECRET: shortSecret,
        });
        expect.unreachable("short secret must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(OrionConfigError);
        expect((error as Error).message).not.toContain(shortSecret);
        expect((error as Error).message).toContain("32 bytes");
      }
    });

    it("rejects non-http(s) URLs, embedded credentials, path prefixes, and illegal targets", () => {
      expect(() =>
        resolveOrion2Config(testEnv({ ORION2_BASE_URL: "ftp://example.com" })),
      ).toThrow(OrionConfigError);
      expect(() =>
        resolveOrion2Config(
          testEnv({ ORION2_BASE_URL: "https://user:pass@example.com" }),
        ),
      ).toThrow(OrionConfigError);
      expect(() =>
        resolveOrion2Config(
          testEnv({ ORION2_BASE_URL: "https://example.com/orion-prefix" }),
        ),
      ).toThrow(OrionConfigError);
      expect(() =>
        resolveOrion2Config(testEnv({ ORION2_DEFAULT_TARGETS: "//..." })),
      ).toThrow(OrionConfigError);
      expect(() =>
        resolveOrion2Config(
          testEnv({ ORION2_DEFAULT_TARGETS: `//${"a".repeat(255)}` }),
        ),
      ).toThrow(OrionConfigError);
      const validCustomTargets = resolveOrion2Config(
        testEnv({ ORION2_DEFAULT_TARGETS: "//app/pkg,//app:foo+bar" }),
      );
      expect(validCustomTargets.defaultTargets).toEqual([
        "//app/pkg",
        "//app:foo+bar",
      ]);
    });
  });

  describe("60s HS256 Service JWT", () => {
    it("mints HS256 JWT with kid, exact orion.v1 claims, 60s TTL, unique jti, and single scope", () => {
      const config = resolveOrion2Config(testEnv());
      const tokenA = signOrionServiceJwt(config, "task.read", {
        nowSeconds: 1_700_000_000,
      });
      const tokenB = signOrionServiceJwt(config, "task.write", {
        nowSeconds: 1_700_000_000,
      });

      const verifiedA = verifyOrionServiceJwtSignature(tokenA, TEST_SECRET);
      const verifiedB = verifyOrionServiceJwtSignature(tokenB, TEST_SECRET);

      expect(verifiedA.header).toEqual({
        alg: "HS256",
        typ: "JWT",
        kid: "key-2026",
      });
      expect(verifiedA.claims.iss).toBe("https://orion.test/issuer");
      expect(verifiedA.claims.aud).toEqual(["orion.v1.server"]);
      expect(verifiedA.claims.sub).toBe("service:megaui-bff");
      expect(verifiedA.claims.environment_id).toBe("env-clb19");
      expect(verifiedA.claims.scope).toBe("task.read");
      expect(verifiedA.claims.nbf).toBe(1_700_000_000);
      expect(verifiedA.claims.exp).toBe(
        1_700_000_000 + ORION2_SERVICE_JWT_TTL_SECS,
      );
      expect(Object.keys(verifiedA.claims).sort()).toEqual([
        "aud",
        "environment_id",
        "exp",
        "iss",
        "jti",
        "nbf",
        "scope",
        "sub",
      ]);
      expect(verifiedB.claims.scope).toBe("task.write");
      expect(verifiedA.claims.jti).not.toBe(verifiedB.claims.jti);
    });
  });

  describe("HTTP & SSE methods", () => {
    it("calls listTasks with task.read scope and parses head_revision + matched_attempt_id", async () => {
      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            items: [
              {
                namespace: ORION_V1_NAMESPACE,
                version: ORION_V1_SCHEMA_VERSION,
                task_id: "task-01",
                attempt_id: "att-02",
                matched_attempt_id: "att-01",
                status: "running",
                targets: ["//:"],
                source: {
                  repo_path: "/project/app",
                  commit_sha: SAMPLE_SHA,
                  cl_link: "cl01",
                  ref_name: "refs/cl/cl01",
                  head_revision: 3,
                },
                created_at: SAMPLE_TS,
                updated_at: SAMPLE_TS,
              },
            ],
            next_cursor: null,
          }),
        );
      };

      const result = await listTasks(
        { clLink: "cl01", attemptId: "att-01", limit: 20 },
        {},
        testEnv(),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.source?.head_revision).toBe(3);
      expect(result.items[0]?.matched_attempt_id).toBe("att-01");
      expect(lastRequest?.method).toBe("GET");
      expect(lastRequest?.url).toBe(
        "/v1/tasks?cl_link=cl01&attempt_id=att-01&limit=20",
      );
      const auth = String(lastRequest?.headers.authorization ?? "");
      expect(auth.startsWith("Bearer ")).toBe(true);
      const { claims } = verifyOrionServiceJwtSignature(
        auth.slice("Bearer ".length),
        TEST_SECRET,
      );
      expect(claims.scope).toBe("task.read");
      expect(lastRequest?.headers["x-request-id"]).toBeTruthy();
    });

    it("calls getTask with task.read scope", async () => {
      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            task_id: "task-99",
            attempt_id: "att-99",
            status: "succeeded",
            targets: ["//app:bin"],
            source: {
              repo_path: "/app",
              commit_sha: SAMPLE_SHA,
              cl_link: "cl99",
              ref_name: "refs/cl/cl99",
              head_revision: 2,
            },
            created_at: SAMPLE_TS,
            updated_at: SAMPLE_TS,
          }),
        );
      };

      const task = await getTask("task-99", {}, testEnv());
      expect(task.task_id).toBe("task-99");
      expect(task.source?.head_revision).toBe(2);
      expect(lastRequest?.url).toBe("/v1/tasks/task-99");
    });

    it("calls createTask with task.write scope, Idempotency-Key, and head_revision", async () => {
      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            task_id: "task-new",
            attempt_id: "att-new",
            status: "accepted",
          }),
        );
      };

      const created = await createTask(
        {
          idempotencyKey: "idem-cl01-rev4",
          source: {
            repo_path: "/project/app",
            commit_sha: SAMPLE_SHA,
            cl_link: "cl01",
            ref_name: "refs/cl/cl01",
            head_revision: 4,
          },
        },
        {},
        testEnv(),
      );
      expect(created.task_id).toBe("task-new");
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.url).toBe("/v1/tasks");
      expect(lastRequest?.headers["idempotency-key"]).toBe("idem-cl01-rev4");
      const sentBody = JSON.parse(lastRequest?.body ?? "{}") as Record<
        string,
        unknown
      >;
      expect(sentBody.environment_id).toBe("env-clb19");
      expect(sentBody.targets).toEqual(["//:"]);
      expect((sentBody.source as Record<string, unknown>).head_revision).toBe(4);
      const auth = String(lastRequest?.headers.authorization ?? "");
      const { claims } = verifyOrionServiceJwtSignature(
        auth.slice("Bearer ".length),
        TEST_SECRET,
      );
      expect(claims.scope).toBe("task.write");
    });

    it("rejects createTask locally when cl_link is set without head_revision", async () => {
      await expect(
        createTask(
          {
            idempotencyKey: "idem-missing-rev",
            source: {
              repo_path: "/project/app",
              commit_sha: SAMPLE_SHA,
              cl_link: "cl01",
            },
          },
          {},
          testEnv(),
        ),
      ).rejects.toMatchObject({
        name: "OrionClientError",
        status: 400,
        code: "invalid_request",
      });
    });

    it("calls retryTask with optional Idempotency-Key and cancelTask with task.write scope", async () => {
      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            task_id: "task-01",
            attempt_id: "att-03",
            status: "accepted",
          }),
        );
      };
      const retried = await retryTask(
        "task-01",
        { idempotencyKey: "retry-key-01" },
        testEnv(),
      );
      expect(retried.attempt_id).toBe("att-03");
      expect(lastRequest?.url).toBe("/v1/tasks/task-01/retry");
      expect(lastRequest?.headers["idempotency-key"]).toBe("retry-key-01");

      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            task_id: "task-01",
            attempt_id: "att-03",
            status: "cancelled",
          }),
        );
      };
      const cancelled = await cancelTask("task-01", {}, testEnv());
      expect(cancelled.status).toBe("cancelled");
      expect(lastRequest?.url).toBe("/v1/tasks/task-01/cancel");
    });

    it("calls listAttemptTargets and listWorkers with task.read scope", async () => {
      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            items: [
              {
                namespace: ORION_V1_NAMESPACE,
                version: ORION_V1_SCHEMA_VERSION,
                status_id: "st-1",
                attempt_id: "att-01",
                task_id: "task-01",
                target_path: "//app:server",
                target_package: "//app",
                target_name: "server",
                target_configuration: "cfg",
                category: "build",
                identifier: "rustc",
                action: "compile",
                status: "success",
                created_at: SAMPLE_TS,
                updated_at: SAMPLE_TS,
              },
            ],
            next_cursor: null,
          }),
        );
      };
      const targets = await listAttemptTargets("att-01", { limit: 10 }, {}, testEnv());
      expect(targets.items[0]?.target_path).toBe("//app:server");
      expect(lastRequest?.url).toBe("/v1/attempts/att-01/targets?limit=10");

      nextHandler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            items: [
              {
                namespace: ORION_V1_NAMESPACE,
                version: ORION_V1_SCHEMA_VERSION,
                session_id: "sess-1",
                worker_id: "wk-1",
                hostname: "worker-host-1",
                status: "connected",
                connected: true,
                last_seen_at: SAMPLE_TS,
                connected_at: SAMPLE_TS,
              },
            ],
            next_cursor: null,
          }),
        );
      };
      const workers = await listWorkers({ status: "connected" }, {}, testEnv());
      expect(workers.items[0]?.connected).toBe(true);
      expect(lastRequest?.url).toBe("/v1/workers/status?status=connected");
    });

    it("opens SSE log stream with log.read scope and fails closed on HTTP redirect", async () => {
      nextHandler = (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.end("id: 1\nevent: log.chunk\ndata: {\"sequence\":1}\n\n");
      };
      const streamRes = await openAttemptLogStream(
        "att-01",
        { after: "1", lastEventId: "1" },
        testEnv(),
      );
      expect(streamRes.status).toBe(200);
      expect(await streamRes.text()).toContain("log.chunk");
      expect(lastRequest?.url).toBe("/v1/attempts/att-01/logs?after=1");
      expect(lastRequest?.headers["last-event-id"]).toBe("1");
      const auth = String(lastRequest?.headers.authorization ?? "");
      const { claims } = verifyOrionServiceJwtSignature(
        auth.slice("Bearer ".length),
        TEST_SECRET,
      );
      expect(claims.scope).toBe("log.read");

      // Redirects MUST be rejected (`redirect: "error"`) so Bearer JWT is never leaked.
      nextHandler = (_req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", "http://127.0.0.1:9999/steal-token");
        res.end();
      };
      await expect(
        openAttemptLogStream("att-01", {}, testEnv()),
      ).rejects.toBeInstanceOf(OrionClientError);
    });

    it("classifies Orion2 ErrorEnvelope responses and rejects malformed responses", async () => {
      nextHandler = (_req, res) => {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            namespace: ORION_V1_NAMESPACE,
            version: ORION_V1_SCHEMA_VERSION,
            error: {
              code: "stale_head_revision",
              message: "head_revision 1 is behind accepted watermark 2",
              request_id: "req-409",
            },
          }),
        );
      };
      try {
        await retryTask("task-01", {}, testEnv());
        expect.unreachable("409 must throw OrionClientError");
      } catch (error) {
        expect(error).toBeInstanceOf(OrionClientError);
        const clientErr = error as OrionClientError;
        expect(clientErr.status).toBe(409);
        expect(clientErr.code).toBe("stale_head_revision");
        expect(clientErr.requestId).toBe("req-409");
        expect(clientErr.isRetryable).toBe(false);
        expect(clientErr.message).not.toContain(TEST_SECRET);
      }

      nextHandler = (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ unexpected: "shape" }));
      };
      await expect(getTask("task-01", {}, testEnv())).rejects.toMatchObject({
        name: "OrionClientError",
        status: 502,
        code: "malformed",
      });
    });

    it("enforces timeout through response body consumption when server stalls after headers", async () => {
      let stalledRes: http.ServerResponse | undefined;
      nextHandler = (_req, res) => {
        stalledRes = res;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.flushHeaders();
        // Deliberately leave body open past timeoutMs
      };
      try {
        await expect(
          getTask("task-stalled", { timeoutMs: 120 }, testEnv()),
        ).rejects.toMatchObject({
          name: "OrionClientError",
          status: 504,
          code: "unavailable",
          isRetryable: true,
        });
      } finally {
        stalledRes?.destroy();
      }
    });

    it("classifies caller abort with a custom reason as non-retryable cancellation", async () => {
      const caller = new AbortController();
      caller.abort(new Error("user cancelled"));

      await expect(
        getTask("task-cancelled", { signal: caller.signal }, testEnv()),
      ).rejects.toMatchObject({
        name: "OrionClientError",
        status: 504,
        code: "unavailable",
        isRetryable: false,
      });

      await expect(
        openAttemptLogStream("att-cancelled", { signal: caller.signal }, testEnv()),
      ).rejects.toMatchObject({
        name: "OrionClientError",
        status: 504,
        code: "unavailable",
        isRetryable: false,
      });
    });
  });
});
