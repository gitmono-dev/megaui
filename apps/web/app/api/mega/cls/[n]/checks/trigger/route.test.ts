import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { megaClLinks, megaClPublicIds, megaCls, user, type Database } from "@megaui/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CSRF_ORIGIN_REJECTED_CODE } from "@/lib/adapter/csrf";
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

const { POST } = await import("./route");

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const PUBLIC_CL_REF = "Abc0_1xyz-23";
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

function createFakeDb(params: {
  members: readonly { id: string; name: string; email: string }[];
  links: ReadonlyMap<number, string>;
}): Database {
  const byId = new Map(params.members.map((m) => [m.id, m]));
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
                    params.members
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
                        return Promise.resolve([{ ...row, banned: false }]);
                      }
                    }
                    return Promise.resolve([]);
                  },
                };
              }
              const bound = extractBoundValue(expr);
              return {
                limit() {
                  if (table === megaClPublicIds) {
                    return Promise.resolve(bound === PUBLIC_CL_REF ? [{ number: 1 }] : []);
                  }
                  if (table === megaClLinks && typeof bound === "number") {
                    const link = params.links.get(bound);
                    return Promise.resolve(link ? [{ link }] : []);
                  }
                  if (table === megaCls) {
                    return Promise.resolve([]);
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

describe("POST /api/mega/cls/[n]/checks/trigger (CLB-25)", () => {
  let mega2Server: http.Server;
  let mega2BaseUrl: string;
  let mega2Handler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => void)
    | undefined;

  let orionServer: http.Server;
  let orionBaseUrl: string;
  let orionHandler:
    | ((req: http.IncomingMessage, body: string, res: http.ServerResponse) => void)
    | undefined;

  const orionCallSpy = vi.fn();
  const mega2CallSpy = vi.fn();

  const envKeys = [
    "APP_BASE_URL",
    "MEGA2_PUBLIC_BASE_URL",
    "ORION2_BASE_URL",
    "ORION2_JWT_HMAC_SECRET",
    "ORION2_ENVIRONMENT_ID",
    "ORION2_DEFAULT_TARGETS",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    mega2Server = http.createServer((req, res) => {
      mega2CallSpy(req.method, req.url);
      if (mega2Handler) {
        mega2Handler(req, res);
        return;
      }
      res.statusCode = 500;
      res.end("no mega2 handler");
    });
    orionServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        orionCallSpy(req.method, req.url, req.headers["idempotency-key"], body);
        if (orionHandler) {
          orionHandler(req, body, res);
          return;
        }
        res.statusCode = 500;
        res.end("no orion handler");
      });
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
    for (const key of envKeys) {
      savedEnv.set(key, process.env[key]);
    }
    process.env.APP_BASE_URL = "https://mega.example.com";
    process.env.MEGA2_PUBLIC_BASE_URL = mega2BaseUrl;
    process.env.ORION2_BASE_URL = orionBaseUrl;
    process.env.ORION2_JWT_HMAC_SECRET = TEST_SECRET;
    process.env.ORION2_ENVIRONMENT_ID = "env_prod";
    process.env.ORION2_DEFAULT_TARGETS = "//:";

    activeFakeDb = createFakeDb({
      members: [
        { id: "u_dev", name: "dev", email: "dev@example.com" },
        { id: "u_reader", name: "reader", email: "reader@example.com" },
      ],
      links: new Map([[1, "cl-abc"]]),
    });
    activeActor = makeActor("u_dev", "dev@example.com");

    orionCallSpy.mockClear();
    mega2CallSpy.mockClear();
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

  function sendMega2Common(res: http.ServerResponse, data: unknown) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ req_result: true, data, err_message: "" }));
  }

  it("rejects cross-site or missing Origin with 403 CSRF_ORIGIN_REJECTED before calling mega2 or orion2", async () => {
    const headerCases: Record<string, string>[] = [
      {
        Origin: "https://evil.example",
        Host: "evil.example",
        "Idempotency-Key": "idem_1",
        cookie: "mega_sess=dev",
      },
      {
        "Idempotency-Key": "idem_1",
        cookie: "mega_sess=dev",
      },
    ];
    for (const headers of headerCases) {
      const req = new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
        method: "POST",
        headers,
      });
      const res = await POST(req, { params: Promise.resolve({ n: "1" }) });
      expect(res.status).toBe(403);
      const body: unknown = await res.json();
      assertMegaFailureEnvelope(body);
      expect(body.error.code).toBe(CSRF_ORIGIN_REJECTED_CODE);
    }
    expect(mega2CallSpy).not.toHaveBeenCalled();
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401 and missing/invalid Idempotency-Key with 400", async () => {
    activeActor = null;
    const unauthReq = new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
      method: "POST",
      headers: { Origin: "https://mega.example.com", "Idempotency-Key": "idem_1" },
    });
    const unauthRes = await POST(unauthReq, { params: Promise.resolve({ n: "1" }) });
    expect(unauthRes.status).toBe(401);

    activeActor = makeActor("u_dev", "dev@example.com");
    const badKeyCases: Record<string, string>[] = [
      { Origin: "https://mega.example.com", cookie: "mega_sess=dev" },
      {
        Origin: "https://mega.example.com",
        cookie: "mega_sess=dev",
        "Idempotency-Key": "bad/key..with/slash",
      },
    ];
    for (const headers of badKeyCases) {
      const badKeyReq = new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
        method: "POST",
        headers,
      });
      const badKeyRes = await POST(badKeyReq, { params: Promise.resolve({ n: "1" }) });
      expect(badKeyRes.status).toBe(400);
      const body: unknown = await badKeyRes.json();
      assertMegaFailureEnvelope(body);
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }

    // Oversized request body (> 32 KiB) is rejected with 413 PAYLOAD_TOO_LARGE before touching mega2/orion2
    const hugeBody = JSON.stringify({ targets: [`//${"a".repeat(40_000)}`] });
    const hugeRes = await POST(
      new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
        method: "POST",
        headers: {
          Origin: "https://mega.example.com",
          cookie: "mega_sess=dev",
          "Idempotency-Key": "idem_huge",
          "Content-Type": "application/json",
        },
        body: hugeBody,
      }),
      { params: Promise.resolve({ n: "1" }) },
    );
    expect(hugeRes.status).toBe(413);
    const hugeJson: unknown = await hugeRes.json();
    assertMegaFailureEnvelope(hugeJson);
    expect(hugeJson.error.code).toBe("PAYLOAD_TOO_LARGE");

    expect(mega2CallSpy).not.toHaveBeenCalled();
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("rejects read-only user (403), off/shadow Cedar (403), and mega2 Cedar unavailable (503) with zero calls to orion2", async () => {
    mega2Handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "ci_authz_denied", message: "Read-only user" }));
    };

    activeActor = makeActor("u_reader", "reader@example.com");
    const req = new Request(`https://mega.example.com/api/mega/cls/${PUBLIC_CL_REF}/checks/trigger`, {
      method: "POST",
      headers: {
        Origin: "https://mega.example.com",
        cookie: "mega_sess=reader",
        "Idempotency-Key": "idem_ro",
      },
    });
    const res403 = await POST(req, { params: Promise.resolve({ n: PUBLIC_CL_REF }) });
    expect(res403.status).toBe(403);
    const body403: unknown = await res403.json();
    assertMegaFailureEnvelope(body403);
    expect(body403.error.code).toBe("ci_authz_denied");

    activeActor = makeActor("u_dev", "dev@example.com");
    mega2Handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          code: "ci_authz_policy_not_enforced",
          message: "Cedar is in shadow mode",
        }),
      );
    };
    const resShadow = await POST(req.clone(), { params: Promise.resolve({ n: PUBLIC_CL_REF }) });
    expect(resShadow.status).toBe(403);
    const bodyShadow: unknown = await resShadow.json();
    assertMegaFailureEnvelope(bodyShadow);
    expect(bodyShadow.error.code).toBe("ci_authz_policy_not_enforced");

    mega2Handler = (_req, res) => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "ci_authz_unavailable", message: "Store down" }));
    };
    const res503 = await POST(req.clone(), { params: Promise.resolve({ n: PUBLIC_CL_REF }) });
    expect(res503.status).toBe(503);
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("rejects non-Open CL with 409 CL_NOT_OPEN and zero calls to orion2", async () => {
    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      if (url.pathname === "/api/v1/cl/cl-abc/ci-authz") {
        expect(url.searchParams.get("action")).toBe("write");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            allowed: true,
            action: "write",
            cl_link: "cl-abc",
            principal: "dev",
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-abc/detail") {
        sendMega2Common(res, {
          id: 1,
          link: "cl-abc",
          title: "Merged CL",
          status: "Merged",
          open_timestamp: 1_700_000_000,
          merge_timestamp: 1_700_000_100,
          conversations: [],
          path: "/services/api",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 2,
          base_branch: "main",
          author: "dev",
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };

    const req = new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
      method: "POST",
      headers: {
        Origin: "https://mega.example.com",
        cookie: "mega_sess=dev",
        "Idempotency-Key": "idem_merged",
      },
    });
    const res = await POST(req, { params: Promise.resolve({ n: "1" }) });
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    assertMegaFailureEnvelope(body);
    expect(body.error.code).toBe("CL_NOT_OPEN");
    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("triggers Orion2 task with head_revision, refs/cl/<link>, task.write JWT, and passes through 409 stale_head_revision with zero secret leakage", async () => {
    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      if (url.pathname === "/api/v1/cl/cl-abc/ci-authz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            allowed: true,
            action: "write",
            cl_link: "cl-abc",
            principal: "dev",
          }),
        );
        return;
      }
      if (url.pathname === "/api/v1/cl/cl-abc/detail") {
        sendMega2Common(res, {
          id: 1,
          link: "cl-abc",
          title: "Open CL",
          status: "Open",
          open_timestamp: 1_700_000_000,
          merge_timestamp: null,
          conversations: [],
          path: "/services/api",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 5,
          base_branch: "main",
          author: "dev",
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    };

    let orionMode: "ok" | "stale" | "leaking_code" = "ok";
    orionHandler = (req, body, res) => {
      const auth = req.headers.authorization ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);
      const claims = JSON.parse(
        Buffer.from(auth.slice("Bearer ".length).split(".")[1]!, "base64url").toString("utf8"),
      ) as { scope: string; environment_id: string; nbf: number; exp: number };
      expect(claims.scope).toBe("task.write");
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.exp - claims.nbf).toBe(60);
      expect(req.headers["idempotency-key"]).toBe("idem_open_5");

      const parsed = JSON.parse(body) as {
        environment_id: string;
        targets: string[];
        source: {
          repo_path: string;
          commit_sha: string;
          cl_link: string;
          ref_name: string;
          head_revision: number;
        };
      };
      expect(parsed.environment_id).toBe("env_prod");
      expect(parsed.targets).toEqual(["//:"]);
      expect(parsed.source).toEqual({
        repo_path: "/services/api",
        commit_sha: SHA_B,
        cl_link: "cl-abc",
        ref_name: "refs/cl/cl-abc",
        head_revision: 5,
      });

      res.setHeader("Content-Type", "application/json");
      if (orionMode === "stale") {
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            error: {
              code: "stale_head_revision",
              message: "head_revision 5 is behind watermark 6",
            },
          }),
        );
        return;
      }
      if (orionMode === "leaking_code") {
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            namespace: "orion.v1",
            version: 1,
            error: {
              code: `leaked_${TEST_SECRET}`,
              message: "conflict",
            },
          }),
        );
        return;
      }
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          namespace: "orion.v1",
          version: 1,
          task_id: "tsk_new_5",
          attempt_id: "att_new_5",
          status: "accepted",
        }),
      );
    };

    const okRes = await POST(
      new Request(`https://mega.example.com/api/mega/cls/${PUBLIC_CL_REF}/checks/trigger`, {
        method: "POST",
        headers: {
          Origin: "https://mega.example.com",
          cookie: "mega_sess=dev",
          "Idempotency-Key": "idem_open_5",
        },
      }),
      { params: Promise.resolve({ n: PUBLIC_CL_REF }) },
    );
    expect(okRes.status).toBe(202);
    expect(okRes.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify([...okRes.headers.entries()])).not.toContain(TEST_SECRET);
    const okText = await okRes.text();
    expect(okText).not.toContain(TEST_SECRET);
    expect(okText).not.toContain("eyJ");
    const okJson: unknown = JSON.parse(okText);
    assertMegaSuccessEnvelope(okJson);
    expect(okJson.data).toMatchObject({
      task_id: "tsk_new_5",
      attempt_id: "att_new_5",
      status: "accepted",
    });

    orionMode = "stale";
    const staleRes = await POST(
      new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
        method: "POST",
        headers: {
          Origin: "https://mega.example.com",
          cookie: "mega_sess=dev",
          "Idempotency-Key": "idem_open_5",
        },
      }),
      { params: Promise.resolve({ n: "1" }) },
    );
    expect(staleRes.status).toBe(409);
    const staleText = await staleRes.text();
    expect(staleText).not.toContain(TEST_SECRET);
    expect(staleText).not.toContain("eyJ");
    const staleJson: unknown = JSON.parse(staleText);
    assertMegaFailureEnvelope(staleJson);
    expect(staleJson.error.code).toBe("stale_head_revision");

    // Non-allowlisted upstream 409 code is mapped to fixed ORION_TASK_CONFLICT (never echoed)
    orionMode = "leaking_code";
    const sanitizedRes = await POST(
      new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
        method: "POST",
        headers: {
          Origin: "https://mega.example.com",
          cookie: "mega_sess=dev",
          "Idempotency-Key": "idem_open_5",
        },
      }),
      { params: Promise.resolve({ n: "1" }) },
    );
    expect(sanitizedRes.status).toBe(409);
    const sanitizedText = await sanitizedRes.text();
    expect(sanitizedText).not.toContain(TEST_SECRET);
    const sanitizedJson: unknown = JSON.parse(sanitizedText);
    assertMegaFailureEnvelope(sanitizedJson);
    expect(sanitizedJson.error.code).toBe("ORION_TASK_CONFLICT");

    // Mismatched detail.link vs authorized clLink is rejected before calling Orion2
    orionCallSpy.mockClear();
    const prevMega2 = mega2Handler;
    mega2Handler = (req, res) => {
      const url = new URL(req.url ?? "/", mega2BaseUrl);
      if (url.pathname === "/api/v1/cl/cl-abc/detail") {
        sendMega2Common(res, {
          id: 99,
          link: "cl-other",
          title: "Other CL",
          status: "Open",
          open_timestamp: 1_700_000_000,
          merge_timestamp: null,
          conversations: [],
          path: "/services/other",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 1,
          base_branch: "main",
          author: "dev",
        });
        return;
      }
      prevMega2?.(req, res);
    };
    const mismatchRes = await POST(
      new Request("https://mega.example.com/api/mega/cls/1/checks/trigger", {
        method: "POST",
        headers: {
          Origin: "https://mega.example.com",
          cookie: "mega_sess=dev",
          "Idempotency-Key": "idem_open_5",
        },
      }),
      { params: Promise.resolve({ n: "1" }) },
    );
    expect(mismatchRes.status).toBe(503);
    expect(orionCallSpy).not.toHaveBeenCalled();
  });
});
