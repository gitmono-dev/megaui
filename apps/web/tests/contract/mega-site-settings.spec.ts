/**
 * Code root README admin setting: mega2 admin check (fail-closed) and the BFF routes
 * `code-readme`, `admin/me`, `admin/code-readme`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  MegaForbiddenError,
  MegaInternalError,
  MegaUnauthorizedError,
  type CodeReadmeSetting,
  type SetCodeReadmeInput,
} from "@megaui/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const sessionState = vi.hoisted(() => ({
  actor: { userId: "usr_admin", email: "admin@example.test" } as { userId: string; email: string } | null,
}));

const store = vi.hoisted(() => ({
  setting: { markdown: "", updatedAt: null, updatedBy: null } as CodeReadmeSetting,
  writes: [] as SetCodeReadmeInput[],
}));

vi.mock("@/lib/enterprise-session", () => ({
  resolveWebActor: async () => sessionState.actor,
}));

vi.mock("@/lib/engine", () => ({
  getSiteSettingsDomain: () => ({
    siteSettings: {
      getCodeReadme: async () => ({ ...store.setting }),
      setCodeReadme: async (input: SetCodeReadmeInput) => {
        store.writes.push(input);
        store.setting = input.markdown.trim()
          ? { markdown: input.markdown, updatedAt: "2026-11-23T00:00:00.000Z", updatedBy: input.actorUserId }
          : { markdown: "", updatedAt: null, updatedBy: null };
        return { ...store.setting };
      },
    },
  }),
}));

import { dispatchMegaRequest } from "../../lib/adapter/dispatch";
import "../../lib/adapter/handlers/site-settings";
import { getMega2AdminStatus, requireMega2Admin } from "../../lib/adapter/mega2/admin";

type StubReply = { status: number; isAdmin?: boolean };

const stubState = { reply: { status: 200, isAdmin: true } as StubReply, requests: [] as { path: string; cookie?: string }[] };

let server: Server;
let baseUrl: string;
let previousMega2Url: string | undefined;

function handle(req: IncomingMessage, res: ServerResponse): void {
  stubState.requests.push({ path: req.url ?? "", cookie: req.headers.cookie });
  const { status, isAdmin } = stubState.reply;
  if (status !== 200) {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end("denied");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ req_result: true, data: { is_admin: isAdmin }, err_message: "" }));
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  previousMega2Url = process.env.MEGA2_PUBLIC_BASE_URL;
  process.env.MEGA2_PUBLIC_BASE_URL = baseUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousMega2Url === undefined) delete process.env.MEGA2_PUBLIC_BASE_URL;
  else process.env.MEGA2_PUBLIC_BASE_URL = previousMega2Url;
});

beforeEach(() => {
  stubState.reply = { status: 200, isAdmin: true };
  stubState.requests.length = 0;
  sessionState.actor = { userId: "usr_admin", email: "admin@example.test" };
  store.setting = { markdown: "", updatedAt: null, updatedBy: null };
  store.writes.length = 0;
});

const cookieHeaders = () => new Headers({ cookie: "session=abc", authorization: "Bearer must-not-forward" });

function dispatch(method: "GET" | "PUT", segments: string[], body?: unknown) {
  return dispatchMegaRequest({ method, segments, searchParams: new URLSearchParams(), body, headers: cookieHeaders() });
}

describe("mega2 admin status", () => {
  it("reads is_admin from /api/v1/admin/me and forwards only the cookie", async () => {
    stubState.reply = { status: 200, isAdmin: true };
    expect(await getMega2AdminStatus(cookieHeaders())).toEqual({ isAdmin: true });
    stubState.reply = { status: 200, isAdmin: false };
    expect(await getMega2AdminStatus(cookieHeaders())).toEqual({ isAdmin: false });
    expect(stubState.requests.map((request) => request.path)).toEqual(["/api/v1/admin/me", "/api/v1/admin/me"]);
    expect(stubState.requests[0]?.cookie).toBe("session=abc");
  });

  it("treats mega2 401/403 as not admin and propagates other failures (fail-closed)", async () => {
    stubState.reply = { status: 401 };
    expect(await getMega2AdminStatus(cookieHeaders())).toEqual({ isAdmin: false });
    stubState.reply = { status: 403 };
    await expect(requireMega2Admin(cookieHeaders())).rejects.toBeInstanceOf(MegaForbiddenError);
    stubState.reply = { status: 500 };
    await expect(getMega2AdminStatus(cookieHeaders())).rejects.toBeInstanceOf(MegaInternalError);
  });
});

describe("site-settings BFF routes", () => {
  it("GET code-readme returns markdown with prose blocks", async () => {
    store.setting = { markdown: "# Title\n\nBody text", updatedAt: "2026-11-23T00:00:00.000Z", updatedBy: "usr_admin" };
    const result = z
      .object({ markdown: z.string(), blocks: z.array(z.unknown()).min(1) })
      .parse(await dispatch("GET", ["code-readme"]));
    expect(result.markdown).toBe("# Title\n\nBody text");
  });

  it("GET admin/me mirrors the mega2 answer", async () => {
    stubState.reply = { status: 200, isAdmin: false };
    expect(await dispatch("GET", ["admin", "me"])).toEqual({ isAdmin: false });
  });

  it("PUT admin/code-readme stores the README for a mega2 admin", async () => {
    const result = z
      .object({ markdown: z.string(), updatedBy: z.string() })
      .parse(await dispatch("PUT", ["admin", "code-readme"], { markdown: "# New" }));
    expect(result).toMatchObject({ markdown: "# New", updatedBy: "usr_admin" });
    expect(store.writes).toEqual([{ markdown: "# New", actorUserId: "usr_admin" }]);
  });

  it("PUT admin/code-readme is forbidden for a non-admin and writes nothing", async () => {
    stubState.reply = { status: 200, isAdmin: false };
    await expect(dispatch("PUT", ["admin", "code-readme"], { markdown: "# New" })).rejects.toBeInstanceOf(
      MegaForbiddenError,
    );
    stubState.reply = { status: 500 };
    await expect(dispatch("PUT", ["admin", "code-readme"], { markdown: "# New" })).rejects.toBeInstanceOf(
      MegaInternalError,
    );
    expect(store.writes).toEqual([]);
  });

  it("PUT admin/code-readme rejects a missing session or malformed body before asking mega2", async () => {
    sessionState.actor = null;
    await expect(dispatch("PUT", ["admin", "code-readme"], { markdown: "x" })).rejects.toBeInstanceOf(
      MegaUnauthorizedError,
    );
    sessionState.actor = { userId: "usr_admin", email: "admin@example.test" };
    await expect(dispatch("PUT", ["admin", "code-readme"], { markdown: 1 })).rejects.toBeInstanceOf(z.ZodError);
    await expect(dispatch("PUT", ["admin", "code-readme"], { markdown: "x", extra: true })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    expect(stubState.requests).toEqual([]);
    expect(store.writes).toEqual([]);
  });
});
