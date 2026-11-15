// FS-03：飞书 token 与固定源 HTTP 传输。
//
// The suite drives the transport and the token manager against a real local
// HTTP server and proves the eight acceptance criteria of the card, including
// the error redaction and the FS-87 single-source contract: a provider
// failure must never produce a request to another source.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { admitProvider } from "@megaui/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeishuTransport, FeishuTransportError } from "./http";
import { FeishuTokenManager } from "./token";

interface TestServer {
  origin: string;
  requests: { url: string; body: string }[];
  close: () => Promise<void>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: { url: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body });
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

function frozenTarget(origin: string) {
  const target = admitProvider({
    enabled: true,
    provider: "simulator",
    role: "development",
    nodeEnv: "test",
    simulatorOrigin: origin,
  });
  if (!target) throw new Error("unreachable: the simulator target must be admitted");
  return target;
}

describe("Feishu token and fixed-origin HTTP transport (FS-03)", () => {
  let primary: TestServer;
  let other: TestServer;

  beforeAll(async () => {
    primary = await startServer((request, response) => {
      if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
        json(response, 200, {
          code: 0,
          msg: "ok",
          tenant_access_token: "t-test-token",
          expire: 7200,
        });
        return;
      }
      json(response, 404, { code: 1, msg: "unknown path" });
    });
    other = await startServer((request, response) => {
      json(response, 200, { code: 0, msg: "ok" });
    });
  });

  afterAll(async () => {
    await primary.close();
    await other.close();
  });

  it("only requests the frozen origin of FS-87", async () => {
    primary.requests.length = 0;
    other.requests.length = 0;
    const transport = new FeishuTransport({ target: frozenTarget(primary.origin) });
    const response = await transport.request<{ code: number }>("/open-apis/health", {
      method: "GET",
    }).catch((error: unknown) => {
      // The primary server answers 404 for an unknown path; the point is
      // that no request left for another origin.
      expect(error).toBeInstanceOf(FeishuTransportError);
      return { code: -1 };
    });
    expect(response).toBeDefined();
    expect(primary.requests.every((request) => request.url.startsWith("/"))).toBe(true);
    expect(other.requests).toHaveLength(0);
    expect(transport.origin).toBe(primary.origin);
  });

  it("refuses a redirect instead of following it", async () => {
    const redirect = await startServer((_request, response) => {
      response.writeHead(302, { location: `${other.origin}/elsewhere` });
      response.end();
    });
    try {
      const transport = new FeishuTransport({ target: frozenTarget(redirect.origin) });
      await expect(transport.request("/redirect")).rejects.toMatchObject({
        code: "transport_redirect",
        status: 302,
      });
      expect(redirect.requests).toHaveLength(1);
      expect(other.requests).toHaveLength(0);
    } finally {
      await redirect.close();
    }
  });

  it("isolates the token cache per tenant and app", async () => {
    primary.requests.length = 0;
    const manager = new FeishuTokenManager({
      transport: new FeishuTransport({ target: frozenTarget(primary.origin) }),
    });
    const first = { tenantKey: "tenant-a", appId: "app-a", appSecret: "secret-a" };
    const second = { tenantKey: "tenant-a", appId: "app-b", appSecret: "secret-b" };
    const third = { tenantKey: "tenant-b", appId: "app-a", appSecret: "secret-a" };

    expect(await manager.getToken(first)).toBe("t-test-token");
    expect(await manager.getToken(second)).toBe("t-test-token");
    expect(await manager.getToken(third)).toBe("t-test-token");
    expect(primary.requests).toHaveLength(3);

    // The cached token of the same tenant and app is reused.
    expect(await manager.getToken(first)).toBe("t-test-token");
    expect(primary.requests).toHaveLength(3);
  });

  it("refreshes once for concurrent callers", async () => {
    const slow = await startServer((_request, response) => {
      setTimeout(() => {
        json(response, 200, {
          code: 0,
          msg: "ok",
          tenant_access_token: "t-test-token",
          expire: 7200,
        });
      }, 100);
    });
    try {
      const manager = new FeishuTokenManager({
        transport: new FeishuTransport({ target: frozenTarget(slow.origin) }),
      });
      const credentials = { tenantKey: "tenant-c", appId: "app-c", appSecret: "secret-c" };
      const tokens = await Promise.all(
        Array.from({ length: 5 }, () => manager.getToken(credentials)),
      );
      expect(tokens).toEqual(Array.from({ length: 5 }, () => "t-test-token"));
      expect(slow.requests).toHaveLength(1);
    } finally {
      await slow.close();
    }
  });

  it("retries a transient error at most three times", async () => {
    const flaky = await startServer((_request, response) => {
      if (flaky.requests.length <= 2) {
        json(response, 500, { code: 8, msg: "provider failure" });
        return;
      }
      json(response, 200, { code: 0, msg: "ok", data: { value: 1 } });
    });
    try {
      const transport = new FeishuTransport({
        target: frozenTarget(flaky.origin),
        backoffMs: 10,
      });
      const result = await transport.request<{ data: { value: number } }>("/flaky");
      expect(result.data.value).toBe(1);
      expect(flaky.requests).toHaveLength(3);
    } finally {
      await flaky.close();
    }
  });

  it("stops after three attempts when the error stays transient", async () => {
    const failing = await startServer((_request, response) => {
      json(response, 503, { code: 8, msg: "unavailable" });
    });
    try {
      const transport = new FeishuTransport({
        target: frozenTarget(failing.origin),
        backoffMs: 10,
      });
      await expect(transport.request("/unavailable")).rejects.toMatchObject({
        code: "transport_transient",
        status: 503,
      });
      expect(failing.requests).toHaveLength(3);
    } finally {
      await failing.close();
    }
  });

  it("keeps one operation inside its total budget", async () => {
    const hanging = await startServer(() => {
      // Never answers.
    });
    try {
      const transport = new FeishuTransport({
        target: frozenTarget(hanging.origin),
        budgetMs: 250,
        backoffMs: 10,
      });
      const started = Date.now();
      await expect(transport.request("/hang")).rejects.toMatchObject({
        code: "transport_timeout",
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await hanging.close();
    }
  });

  it("does not retry a permanent permission error", async () => {
    const forbidden = await startServer((_request, response) => {
      json(response, 403, { code: 3, msg: "forbidden" });
    });
    try {
      const transport = new FeishuTransport({
        target: frozenTarget(forbidden.origin),
        backoffMs: 10,
      });
      await expect(transport.request("/forbidden")).rejects.toMatchObject({
        code: "transport_permanent",
        status: 403,
      });
      expect(forbidden.requests).toHaveLength(1);
    } finally {
      await forbidden.close();
    }
  });

  it("keeps tokens and secrets out of the error output", async () => {
    const leaking = await startServer((_request, response) => {
      json(response, 500, { code: 8, msg: "provider failure", tenant_access_token: "t-leak" });
    });
    try {
      const manager = new FeishuTokenManager({
        transport: new FeishuTransport({
          target: frozenTarget(leaking.origin),
          backoffMs: 10,
        }),
      });
      let message = "";
      try {
        await manager.getToken({ tenantKey: "tenant-d", appId: "app-d", appSecret: "secret-d" });
        throw new Error("unreachable: the refresh must fail");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain("secret-d");
      expect(message).not.toContain("t-leak");
      expect(leaking.requests).toHaveLength(3);
    } finally {
      await leaking.close();
    }
  });
});
