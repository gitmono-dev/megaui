import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import {
  MOCK_MAX_BODY_BYTES,
  MOCK_READ_BUDGET_MS,
  mockError,
  queryOf,
  rejectUnknownFields,
  validateMockRequest,
} from "../../src/http";
import { startMockListener, type MockListener } from "../../src/server";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

let listener: MockListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

interface Response {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? "GET", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

/** Sends a request that never finishes its body, so the server budget decides. */
function callWithUnfinishedBody(baseUrl: string, path: string): Promise<Response> {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "4096" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body, headers: response.headers });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.write('{"partial":');
    // The request is never ended: the server has to answer on its own budget.
  });
}

/** Sends request headers that never complete, so the server budget decides. */
function callWithUnfinishedHeaders(baseUrl: string): Promise<string> {
  const target = new URL(baseUrl);
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {
      socket.write(`GET /health HTTP/1.1\r\nHost: ${target.host}\r\n`);
    });
    let raw = "";
    socket.on("data", (chunk) => {
      raw += String(chunk);
    });
    socket.on("end", () => resolvePromise(raw));
    socket.on("close", () => resolvePromise(raw));
    socket.on("error", reject);
  });
}

describe("mock HTTP boundary (FSM-06)", () => {
  it("answers GET /health with the frozen shape", async () => {
    listener = await startMockListener(CONFIG);
    const response = await call(listener.baseUrl, "/health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, service: "feishu-mock" });
  });

  it("requires the exact listener host", async () => {
    listener = await startMockListener(CONFIG);
    const response = await call(listener.baseUrl, "/health", { headers: { host: "127.0.0.1:1" } });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ code: 1, msg: "mock_host_mismatch" });
  });

  it("rejects a forwarded host", async () => {
    listener = await startMockListener(CONFIG);
    const response = await call(listener.baseUrl, "/health", {
      headers: { "x-forwarded-host": "example.com" },
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ code: 1, msg: "mock_forwarded_host_rejected" });
  });

  it("accepts only application/json for requests with a body", () => {
    const base = {
      expectedHost: "127.0.0.1:19400",
      method: "POST",
      url: "/x",
      headers: { host: "127.0.0.1:19400" } as Record<string, string | string[] | undefined>,
    };
    expect(validateMockRequest({ ...base, headers: { host: "127.0.0.1:19400", "content-type": "text/plain" } })?.msg).toBe(
      "mock_content_type_invalid",
    );
    expect(validateMockRequest({ ...base, headers: { host: "127.0.0.1:19400", "content-type": "application/json; charset=utf-8" } })).toBeUndefined();
    expect(validateMockRequest({ ...base, headers: { host: "127.0.0.1:19400", "content-type": "application/json" } })).toBeUndefined();
  });

  it("rejects duplicate and empty query parameters", () => {
    const base = {
      expectedHost: "127.0.0.1:19400",
      method: "GET",
      headers: { host: "127.0.0.1:19400" } as Record<string, string | string[] | undefined>,
    };
    expect(validateMockRequest({ ...base, url: "/x?a=1&a=2" })?.msg).toBe("mock_query_duplicate");
    expect(validateMockRequest({ ...base, url: "/x?a=" })?.msg).toBe("mock_query_invalid");
    expect(validateMockRequest({ ...base, url: "/x?a=1" })).toBeUndefined();
  });

  it("rejects unknown body fields", () => {
    expect(rejectUnknownFields({ known: 1, extra: 2 }, ["known"])?.msg).toBe("mock_unknown_field");
    expect(rejectUnknownFields({ known: 1 }, ["known"])).toBeUndefined();
  });

  it("parses query parameters", () => {
    const query = queryOf("/x?a=1&b=2&a=3");
    expect(query.get("a")).toEqual(["1", "3"]);
    expect(query.get("b")).toEqual(["2"]);
    expect(queryOf("/x").size).toBe(0);
  });

  it("rejects a body over 32KiB", async () => {
    listener = await startMockListener(CONFIG);
    const oversized = JSON.stringify({ pad: "x".repeat(MOCK_MAX_BODY_BYTES) });
    const response = await call(listener.baseUrl, "/x", { method: "POST", body: oversized });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ code: 1, msg: "mock_body_too_large" });
  });

  it("rejects a body that is not a JSON object", async () => {
    listener = await startMockListener(CONFIG);
    const response = await call(listener.baseUrl, "/x", { method: "POST", body: "not json" });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ code: 1, msg: "mock_body_invalid" });
  });

  it("answers 404 for routes no earlier card delivers", async () => {
    listener = await startMockListener(CONFIG);
    // The contact routes are delivered by FSM-09 and FSM-18, so the path that
    // no card delivers is used here.
    const response = await call(listener.baseUrl, "/open-apis/unknown/path");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ code: 4, msg: "not_found" });
  });

  it("maps every frozen error code to its http status", () => {
    expect(mockError(1, "m").httpStatus).toBe(400);
    expect(mockError(2, "m").httpStatus).toBe(401);
    expect(mockError(3, "m").httpStatus).toBe(403);
    expect(mockError(4, "m").httpStatus).toBe(404);
    expect(mockError(5, "m").httpStatus).toBe(409);
    expect(mockError(6, "m").httpStatus).toBe(429);
    expect(mockError(7, "m").httpStatus).toBe(504);
    expect(mockError(8, "m").httpStatus).toBe(503);
  });

  it("never echoes the request body in an error", async () => {
    listener = await startMockListener(CONFIG);
    const response = await call(listener.baseUrl, "/x", {
      method: "POST",
      body: JSON.stringify({ secret: "super-secret" }),
    });
    expect(response.body).not.toContain("super-secret");
    expect(JSON.parse(response.body)).toEqual({ code: 1, msg: "mock_unknown_field" });
  });

  it("keeps the frozen read budget at five seconds", () => {
    expect(MOCK_READ_BUDGET_MS).toBe(5_000);
  });

  it("answers the frozen 504 when the body read budget is exhausted", async () => {
    listener = await startMockListener(CONFIG);
    const started = Date.now();
    const response = await callWithUnfinishedBody(listener.baseUrl, "/x");
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toEqual({ code: 7, msg: "mock_read_timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  }, 20_000);

  it("answers the frozen 504 when the header read budget is exhausted", async () => {
    listener = await startMockListener(CONFIG);
    const started = Date.now();
    const raw = await callWithUnfinishedHeaders(listener.baseUrl);
    expect(raw).toContain("504 Gateway Timeout");
    expect(raw).toContain('{"code":7,"msg":"mock_read_timeout"}');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  }, 20_000);
});
