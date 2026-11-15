// FS-12：应用机器人私聊消息 client。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { admitProvider } from "@megaui/core";
import { afterEach, describe, expect, it } from "vitest";

import { FeishuMessageClient } from "./message";
import { FeishuTransport } from "./http";
import { FeishuTokenManager } from "./token";

interface TestServer {
  readonly origin: string;
  readonly requests: { url: string; headers: IncomingMessage["headers"]; body: string }[];
  readonly close: () => Promise<void>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", headers: request.headers, body });
      handler(request, response, body);
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

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function transportFor(origin: string, budgetMs = 20_000): FeishuTransport {
  const target = admitProvider({
    enabled: true,
    provider: "simulator",
    role: "development",
    nodeEnv: "test",
    simulatorOrigin: origin,
  });
  if (!target) throw new Error("unreachable: simulator target must be admitted");
  return new FeishuTransport({ target, budgetMs, backoffMs: 5 });
}

const CREDENTIALS = {
  tenantKey: "tenant-test",
  appId: "app-test",
  appSecret: "secret-test",
};

const INPUT = {
  boundOpenId: "ou_bound_alice",
  code: "2ABCD4EF",
  uuid: "delivery-uuid-1",
};

const TRUSTED_SITE = "https://megaui.example.test/login";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function clientFor(origin: string, budgetMs?: number): FeishuMessageClient {
  return new FeishuMessageClient({
    transport: transportFor(origin, budgetMs),
    credentials: CREDENTIALS,
    getToken: async () => "tenant-token",
    trustedSiteUrl: TRUSTED_SITE,
  });
}

describe("application-bot direct messages (FS-12)", () => {
  it("sends only to the bound open_id with a trusted-site login purpose", async () => {
    server = await startServer((request, response, body) => {
      if (request.url === "/open-apis/im/v1/messages?receive_id_type=open_id") {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed.receive_id).toBe(INPUT.boundOpenId);
        expect(parsed.msg_type).toBe("text");
        expect(parsed.uuid).toBe(INPUT.uuid);
        const content = JSON.parse(String(parsed.content)) as { text: string };
        expect(typeof content.text).toBe("string");
        expect(content.text).toContain("企业登录");
        expect(content.text).toContain(TRUSTED_SITE);
        expect(content.text).toContain(INPUT.code);
        expect(request.headers.authorization).toBe("Bearer tenant-token");
        json(response, 200, {
          code: 0,
          msg: "ok",
          data: {
            message_id: "om-message-1",
            receive_id: INPUT.boundOpenId,
            msg_type: "text",
            content: parsed.content,
          },
        });
        return;
      }
      json(response, 404, { code: 1, msg: "not_found" });
    });

    const result = await clientFor(server.origin).send(INPUT);
    expect(result).toEqual({ kind: "accepted", uuid: INPUT.uuid, messageId: "om-message-1" });
    expect(server.requests).toHaveLength(1);
  });

  it("reuses the tenant token layer instead of refreshing for each message", async () => {
    server = await startServer((_request, response, body) => {
      if (server!.requests[server!.requests.length - 1]?.url === "/open-apis/auth/v3/tenant_access_token/internal") {
        json(response, 200, {
          code: 0,
          msg: "ok",
          tenant_access_token: "cached-tenant-token",
          expire: 7200,
        });
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: {
          message_id: `om-${String(parsed.uuid)}`,
          receive_id: parsed.receive_id,
          msg_type: parsed.msg_type,
          content: parsed.content,
        },
      });
    });
    const transport = transportFor(server.origin);
    const tokenManager = new FeishuTokenManager({ transport });
    const client = new FeishuMessageClient({
      transport,
      tokenManager,
      credentials: CREDENTIALS,
      trustedSiteUrl: TRUSTED_SITE,
    });

    await expect(client.send(INPUT)).resolves.toMatchObject({ kind: "accepted" });
    await expect(client.send({ ...INPUT, uuid: "delivery-uuid-2" })).resolves.toMatchObject({ kind: "accepted" });
    expect(server.requests.filter(({ url }) => url === "/open-apis/auth/v3/tenant_access_token/internal")).toHaveLength(1);
    expect(server.requests.filter(({ url }) => url === "/open-apis/im/v1/messages?receive_id_type=open_id")).toHaveLength(2);
    expect(server.requests.filter(({ headers }) => headers.authorization === "Bearer cached-tenant-token")).toHaveLength(2);
  });

  it("reuses one UUID and the same payload for transient retries", async () => {
    server = await startServer((request, response, body) => {
      if (server!.requests.length < 3) {
        json(response, 500, { code: 8, msg: "temporary" });
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: {
          message_id: "om-message-retry",
          receive_id: parsed.receive_id,
          msg_type: parsed.msg_type,
          content: parsed.content,
        },
      });
      void request;
    });

    const result = await clientFor(server.origin).send(INPUT);
    expect(result.kind).toBe("accepted");
    expect(server.requests).toHaveLength(3);
    expect(server.requests.map(({ body }) => JSON.parse(body))).toHaveLength(3);
    const bodies = server.requests.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
    expect(bodies.map((body) => body.uuid)).toEqual([INPUT.uuid, INPUT.uuid, INPUT.uuid]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it("marks a message timeout unknown instead of manufacturing a second code", async () => {
    server = await startServer((_request, _response) => {
      // The transport's per-operation deadline aborts this request.
    });
    const result = await clientFor(server.origin, 80).send(INPUT);
    expect(result).toMatchObject({ kind: "unknown", uuid: INPUT.uuid, stage: "message" });
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it("does not retry a permanent permission failure", async () => {
    server = await startServer((_request, response) => {
      json(response, 403, { code: 3, msg: "forbidden" });
    });
    const result = await clientFor(server.origin).send(INPUT);
    expect(result).toMatchObject({ kind: "rejected", uuid: INPUT.uuid, reason: "permission", status: 403 });
    expect(server.requests).toHaveLength(1);
  });

  it("rejects a malformed successful provider envelope without exposing its body", async () => {
    server = await startServer((_request, response) => {
      json(response, 200, { code: 0, msg: "ok", data: { message_id: "" } });
    });
    const result = await clientFor(server.origin).send(INPUT);
    expect(result).toEqual({ kind: "rejected", uuid: INPUT.uuid, reason: "invalid_response" });
  });
});
