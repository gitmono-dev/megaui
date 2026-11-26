import http from "node:http";
import type { AddressInfo } from "node:net";
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

const { GET: getWorkersStatus } = await import("./route");

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

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
  members: readonly { id: string; banned?: boolean }[],
  options: { readonly failDb?: boolean } = {},
): Database {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where(expr: unknown) {
              return {
                limit() {
                  if (options.failDb) {
                    return Promise.reject(new Error("db offline"));
                  }
                  if (table === user) {
                    const id = extractBoundValue(expr);
                    if (typeof id === "string") {
                      const row = byId.get(id);
                      if (row) return Promise.resolve([{ id: row.id, banned: row.banned ?? false }]);
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

describe("GET /api/mega/orion/workers/status (CLB-28)", () => {
  let orionServer: http.Server;
  let orionBaseUrl: string;
  let orionHandler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => void)
    | undefined;

  const orionCallSpy = vi.fn();
  const envKeys = [
    "ORION2_BASE_URL",
    "ORION2_JWT_HMAC_SECRET",
    "ORION2_ENVIRONMENT_ID",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    orionServer = http.createServer((req, res) => {
      orionCallSpy(req.method, req.url, req.headers.authorization);
      if (orionHandler) {
        orionHandler(req, res);
        return;
      }
      res.statusCode = 500;
      res.end("no orion handler");
    });
    await new Promise<void>((resolve) =>
      orionServer.listen(0, "127.0.0.1", () => resolve()),
    );
    orionBaseUrl = `http://127.0.0.1:${(orionServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      orionServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.ORION2_BASE_URL = orionBaseUrl;
    process.env.ORION2_JWT_HMAC_SECRET = TEST_SECRET;
    process.env.ORION2_ENVIRONMENT_ID = "env_prod";

    activeFakeDb = createFakeMemberDb([
      { id: "u_member", banned: false },
      { id: "u_banned", banned: true },
    ]);
    activeActor = makeActor("u_member", "member@example.com");
    orionCallSpy.mockClear();
    orionHandler = undefined;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const prev = savedEnv.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("returns 503 ORION2_UNCONFIGURED, 401 unauthenticated, 403 non-member/banned, 503 db error, and 400 invalid queries with zero Orion2 calls", async () => {
    delete process.env.ORION2_BASE_URL;
    const uncfg = await getWorkersStatus(
      new Request("https://mega.example.com/api/mega/orion/workers/status"),
    );
    expect(uncfg.status).toBe(503);
    const { json: uncfgBody } = await readAndAssertSafeResponse(uncfg);
    assertMegaFailureEnvelope(uncfgBody);
    expect(uncfgBody.error.code).toBe("ORION2_UNCONFIGURED");

    process.env.ORION2_BASE_URL = orionBaseUrl;
    activeActor = null;
    const unauth = await getWorkersStatus(
      new Request("https://mega.example.com/api/mega/orion/workers/status"),
    );
    expect(unauth.status).toBe(401);
    await readAndAssertSafeResponse(unauth);

    // Non-workspace member -> 403 even with invalid query params (membership check runs first)
    activeActor = makeActor("u_outsider", "outsider@example.com");
    const nonMember = await getWorkersStatus(
      new Request("https://mega.example.com/api/mega/orion/workers/status?limit=0"),
    );
    expect(nonMember.status).toBe(403);
    await readAndAssertSafeResponse(nonMember);

    // Banned workspace member -> 403 even with invalid query params
    activeActor = makeActor("u_banned", "banned@example.com");
    const bannedMember = await getWorkersStatus(
      new Request("https://mega.example.com/api/mega/orion/workers/status?limit=0"),
    );
    expect(bannedMember.status).toBe(403);
    await readAndAssertSafeResponse(bannedMember);

    // Membership DB unavailable -> 503 even with invalid query params
    activeActor = makeActor("u_member", "member@example.com");
    activeFakeDb = createFakeMemberDb([], { failDb: true });
    const dbDown = await getWorkersStatus(
      new Request("https://mega.example.com/api/mega/orion/workers/status?limit=0"),
    );
    expect(dbDown.status).toBe(503);
    await readAndAssertSafeResponse(dbDown);

    // Invalid query params -> 400
    activeFakeDb = createFakeMemberDb([{ id: "u_member", banned: false }]);
    const badUrls = [
      "https://mega.example.com/api/mega/orion/workers/status?status=bogus",
      "https://mega.example.com/api/mega/orion/workers/status?limit=0",
      "https://mega.example.com/api/mega/orion/workers/status?limit=101",
      "https://mega.example.com/api/mega/orion/workers/status?limit=10&limit=20",
      "https://mega.example.com/api/mega/orion/workers/status?unknown=1",
      "https://mega.example.com/api/mega/orion/workers/status?cursor=",
    ];
    for (const url of badUrls) {
      const res = await getWorkersStatus(new Request(url));
      expect(res.status, `expected 400 for ${url}`).toBe(400);
      await readAndAssertSafeResponse(res);
    }

    expect(orionCallSpy).not.toHaveBeenCalled();
  });

  it("queries GET /v1/workers/status with 60s task.read JWT pinned to server ORION2_ENVIRONMENT_ID, ignoring client environment_id", async () => {
    orionHandler = (req, res) => {
      const claims = decodeJwtClaims(req.headers.authorization);
      expect(claims.scope).toBe("task.read");
      expect(claims.environment_id).toBe("env_prod");
      expect(claims.exp - claims.nbf).toBe(60);

      const url = new URL(req.url!, orionBaseUrl);
      expect(url.pathname).toBe("/v1/workers/status");
      expect(url.searchParams.has("environment_id")).toBe(false);
      expect(url.searchParams.get("status")).toBe("connected");
      expect(url.searchParams.get("limit")).toBe("20");
      expect(url.searchParams.get("cursor")).toBe("cur_w1");

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
              session_id: "ws_1",
              worker_id: "wrk_1",
              hostname: "worker-01",
              status: "connected",
              connected: true,
              last_seen_at: "2026-11-24T10:00:00Z",
              connected_at: "2026-11-24T09:50:00Z",
            },
          ],
          next_cursor: null,
        }),
      );
    };

    const ok = await getWorkersStatus(
      new Request(
        "https://mega.example.com/api/mega/orion/workers/status?environment_id=env_attacker&status=connected&limit=20&cursor=cur_w1",
      ),
    );
    expect(ok.status).toBe(200);
    const { json } = await readAndAssertSafeResponse(ok);
    assertMegaSuccessEnvelope(json);
    expect(json.data).toMatchObject({
      items: [{ worker_id: "wrk_1", status: "connected", connected: true }],
    });
    expect(orionCallSpy).toHaveBeenCalledTimes(1);
  });
});
