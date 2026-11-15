/** FS-78: the shared Web actor gate closes every business entry in maintenance. */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readSession = vi.hoisted(() => vi.fn(async () => null));
const resolveMode = vi.hoisted(() => vi.fn(async () => "maintenance" as const));
const getReady = vi.hoisted(() => vi.fn(() => ({
  auth: { api: { getSession: readSession } },
  database: { db: {}, pool: {} },
})));
const readConfig = vi.hoisted(() => vi.fn(() => ({
  mode: "legacy" as const,
  scope: {
    processRole: "web" as const,
    ownerFingerprint: "fs78-owner",
    instanceId: "fs78-instance",
    environment: "test" as const,
  },
})));

vi.mock("@/lib/auth", () => ({
  getAuth: vi.fn(),
  prepareWebAuth: vi.fn(),
  resolveCurrentWebAuthMode: resolveMode,
}));
vi.mock("@/lib/enterprise-config", () => ({ readEnterpriseWebConfig: readConfig }));
vi.mock("@/lib/enterprise-runtime", () => ({ getReadyWebAssembly: getReady }));

import { GET as megaGet, POST as megaPost } from "../../app/api/mega/[...segments]/route";
import { POST as uploadPost } from "../../app/api/upload/route";
import { authMiddleware } from "../../middlewares/auth";
import { createWebActorResolver, resolveWebActor } from "../../lib/enterprise-session";

function routeContext(segments: string[]) {
  return { params: Promise.resolve({ segments }) };
}

describe("FS-78 maintenance business-access gate", () => {
  beforeEach(() => {
    readSession.mockClear();
    resolveMode.mockClear();
    getReady.mockClear();
    readConfig.mockClear();
    process.env.AUTH_MODE = "maintenance";
  });

  it("short-circuits maintenance before reading a Better Auth session", async () => {
    const read = vi.fn(async () => ({
      user: { id: "stale-user" },
      session: { id: "stale-session" },
    }));
    const resolve = createWebActorResolver({ mode: "maintenance", readSession: read });
    await expect(resolve(new Headers({ cookie: "stale=1" }))).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not restore legacy access when a scoped persistent policy is maintenance", async () => {
    await expect(resolveWebActor(new Headers({ cookie: "stale=1" }))).resolves.toBeNull();
    expect(getReady).toHaveBeenCalledTimes(1);
    expect(resolveMode).toHaveBeenCalledTimes(1);
    expect(readSession).not.toHaveBeenCalled();
  });

  it("rejects protected pages, BFF business, upload, and new SSE tickets", async () => {
    const page = await authMiddleware(new NextRequest("http://127.0.0.1:3000/en/workspace"));
    expect(page?.status).toBe(302);

    const bff = await megaGet(
      new Request("http://127.0.0.1:3000/api/mega/collab/token"),
      routeContext(["collab", "token"]),
    );
    expect(bff.status).toBe(401);

    const sse = await megaPost(
      new Request("http://127.0.0.1:3000/api/mega/agent/thread/ask", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "content-type": "application/json" },
      }),
      routeContext(["agent", "thread", "ask"]),
    );
    expect(sse.status).toBe(401);

    const form = new FormData();
    form.append("file", new File(["x"], "note.txt", { type: "text/plain" }));
    const upload = await uploadPost(new Request("http://127.0.0.1:3000/api/upload", {
      method: "POST",
      body: form,
    }));
    expect(upload.status).toBe(401);
  });

  it("keeps only the approved anonymous callback, introspection, health, and sign-out paths public", async () => {
    expect(await authMiddleware(new NextRequest("http://127.0.0.1:3000/api/health"))).toBeUndefined();
    expect(await authMiddleware(new NextRequest(
      "http://127.0.0.1:3000/api/integrations/feishu/events",
      { method: "POST" },
    ))).toBeUndefined();
    expect(await authMiddleware(new NextRequest(
      "http://127.0.0.1:3000/api/internal/enterprise/eligibility",
      { method: "POST" },
    ))).toBeUndefined();
    expect(await authMiddleware(new NextRequest("http://127.0.0.1:3000/api/auth/sign-out", {
      method: "POST",
    }))).toBeUndefined();
  });
});
