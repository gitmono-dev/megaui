import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MegaBadRequestError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { getMega2CommonResult, getMega2Json } from "./client";
import { Mega2ConfigError } from "./types";

const serviceDir = path.dirname(fileURLToPath(import.meta.url));

interface StubServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StubServerHandle> {
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

let activeServer: StubServerHandle | undefined;

afterEach(async () => {
  await activeServer?.close();
  activeServer = undefined;
});

describe("mega2 client (EG-11 contract, config)", () => {
  it("fails closed with an actionable message when MEGA2_PUBLIC_BASE_URL is unset", async () => {
    await expect(
      getMega2Json("/api/v1/latest-commit", z.unknown(), {}, {}),
    ).rejects.toThrow(/MEGA2_PUBLIC_BASE_URL/);
    await expect(
      getMega2Json("/api/v1/latest-commit", z.unknown(), {}, {}),
    ).rejects.toBeInstanceOf(Mega2ConfigError);
  });

  it("treats blank MEGA2_PUBLIC_BASE_URL the same as unset", async () => {
    await expect(
      getMega2Json("/api/v1/latest-commit", z.unknown(), {}, { MEGA2_PUBLIC_BASE_URL: "   " }),
    ).rejects.toBeInstanceOf(Mega2ConfigError);
  });

  it("is a domain error recognized by the engine's shared error contract (isMegaError)", async () => {
    await expect(
      getMega2Json("/api/v1/latest-commit", z.unknown(), {}, {}),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });
});

describe("mega2 client (EG-11 contract, HTTP status classification)", () => {
  it("maps 401 to MegaUnauthorizedError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 401, "no session"));
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaUnauthorizedError);
  });

  it("maps 403 to MegaForbiddenError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 403, "denied"));
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaForbiddenError);
  });

  it("maps 404 to MegaNotFoundError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 404, "missing"));
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaNotFoundError);
  });

  it("maps 400 to MegaBadRequestError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 400, "bad path"));
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaBadRequestError);
  });

  it("maps 422 to MegaBadRequestError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 422, "unprocessable"));
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaBadRequestError);
  });

  it("maps 500 (and any other non-2xx) to MegaInternalError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 500, "boom"));
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });
});

describe("mega2 client (EG-11 contract, CommonResult unwrap)", () => {
  it("unwraps req_result=true and zod-validates data", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, { req_result: true, data: "hello world", err_message: "" }),
    );
    const data = await getMega2CommonResult(
      "/api/v1/blob",
      z.string(),
      {},
      { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
    );
    expect(data).toBe("hello world");
  });

  it("maps req_result=false with a 'not found' message to MegaNotFoundError", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, { req_result: false, data: null, err_message: "Tree node not found" }),
    );
    await expect(
      getMega2CommonResult(
        "/api/v1/tree",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaNotFoundError);
  });

  it("maps req_result=false with any other message to MegaBadRequestError", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, { req_result: false, data: null, err_message: "invalid refs" }),
    );
    await expect(
      getMega2CommonResult(
        "/api/v1/tree",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaBadRequestError);
  });

  it("maps req_result=true with null data to MegaInternalError", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, { req_result: true, data: null, err_message: "" }),
    );
    await expect(
      getMega2CommonResult(
        "/api/v1/blob",
        z.string(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });
});

describe("mega2 client (EG-11 contract, malformed responses)", () => {
  it("maps a non-JSON 200 body to MegaInternalError", async () => {
    activeServer = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json {{{");
    });
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.unknown(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });

  it("maps an envelope missing req_result to MegaInternalError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 200, { data: "x" }));
    await expect(
      getMega2CommonResult(
        "/api/v1/blob",
        z.string(),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });

  it("maps data that fails the pinned per-endpoint schema to MegaInternalError", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, { oid: "abc123" }),
    );
    await expect(
      getMega2Json(
        "/api/v1/latest-commit",
        z.object({
          oid: z.string(),
          date: z.string(),
          short_message: z.string(),
          author: z.string(),
          committer: z.string(),
          status: z.string(),
        }),
        {},
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });
});

describe("mega2 client (EG-11 contract, ER-10 bounded retry)", () => {
  it("retries a transient 503 and eventually succeeds", async () => {
    let calls = 0;
    activeServer = await startStubServer((_req, res) => {
      calls += 1;
      if (calls < 3) {
        sendJson(res, 503, "temporarily unavailable");
        return;
      }
      sendJson(res, 200, "recovered");
    });

    const data = await getMega2Json(
      "/api/v1/blob",
      z.string(),
      { retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 } },
      { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
    );
    expect(data).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("retries a 429 and eventually succeeds", async () => {
    let calls = 0;
    activeServer = await startStubServer((_req, res) => {
      calls += 1;
      if (calls < 2) {
        sendJson(res, 429, "rate limited");
        return;
      }
      sendJson(res, 200, "ok now");
    });

    const data = await getMega2Json(
      "/api/v1/blob",
      z.string(),
      { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } },
      { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
    );
    expect(data).toBe("ok now");
    expect(calls).toBe(2);
  });

  it("exhausts the bounded retry budget on a persistent 503 and maps to MegaInternalError", async () => {
    let calls = 0;
    activeServer = await startStubServer((_req, res) => {
      calls += 1;
      sendJson(res, 503, "still down");
    });

    await expect(
      getMega2Json(
        "/api/v1/blob",
        z.string(),
        { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } },
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
    expect(calls).toBe(3);
  });

  it("does not retry a deterministic 400 response (ER-10: fails on the first attempt)", async () => {
    let calls = 0;
    activeServer = await startStubServer((_req, res) => {
      calls += 1;
      sendJson(res, 400, "bad path");
    });

    await expect(
      getMega2Json(
        "/api/v1/blob",
        z.string(),
        { retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 } },
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaBadRequestError);
    expect(calls).toBe(1);
  });

  it("does not retry a deterministic 404 response", async () => {
    let calls = 0;
    activeServer = await startStubServer((_req, res) => {
      calls += 1;
      sendJson(res, 404, "missing");
    });

    await expect(
      getMega2Json(
        "/api/v1/blob",
        z.string(),
        { retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 } },
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaNotFoundError);
    expect(calls).toBe(1);
  });

  it("does not retry a deterministic 422 response", async () => {
    let calls = 0;
    activeServer = await startStubServer((_req, res) => {
      calls += 1;
      sendJson(res, 422, "unprocessable");
    });

    await expect(
      getMega2Json(
        "/api/v1/blob",
        z.string(),
        { retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 } },
        { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaBadRequestError);
    expect(calls).toBe(1);
  });

  it("bounds retry attempts on a network-level connection failure (ECONNREFUSED, surfaced as a TypeError) instead of hanging", async () => {
    // Bind and immediately close a server to get a port nothing is
    // listening on — `fetch` rejects with a `TypeError` at the TCP layer,
    // no HTTP response ever exists.
    const server = await startStubServer((_req, res) => sendJson(res, 200, "unreachable"));
    const baseUrl = server.baseUrl;
    await server.close();

    await expect(
      getMega2Json(
        "/api/v1/blob",
        z.string(),
        { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } },
        { MEGA2_PUBLIC_BASE_URL: baseUrl },
      ),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });
});

describe("mega2 service directory (EG-11 contract, no mock runtime fallback — DEBT-04)", () => {
  function listProductionSourceFiles(): string[] {
    return readdirSync(serviceDir)
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => path.join(serviceDir, entry));
  }

  it("has zero 'fixtures' occurrences in production source (this test file is exempt: it names the guard)", () => {
    const files = listProductionSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    const hits = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => content.includes("fixtures"))
      .map(({ file }) => path.basename(file));
    expect(hits).toEqual([]);
  });

  it("has no data-backend mock-vs-mega2 switch in production source", () => {
    const files = listProductionSourceFiles();
    const hits = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => /_DATA_BACKEND|mockGet|mockList/.test(content))
      .map(({ file }) => path.basename(file));
    expect(hits).toEqual([]);
  });
});
