// megaui-only (FSL-126): the Web session entry and middleware outside and inside Feishu mode.
// No database or socket: Better Auth and the shared Pool are replaced by spies, so the
// legacy case can assert that the Feishu marker table is never consulted.
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = vi.hoisted(() => ({
  user: { id: "fsl126-user", email: "user@example.test" },
  session: { id: "fsl126-session" },
}));
const getSession = vi.hoisted(() => vi.fn(async ({ headers }: { headers: Headers }) =>
  headers.get("cookie")?.includes("password-session") ? SESSION : null));
const getAuth = vi.hoisted(() => vi.fn(() => ({ api: { getSession } })));
const markerQuery = vi.hoisted(() => vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })));
const getPool = vi.hoisted(() => vi.fn(() => ({ query: markerQuery })));
const getReady = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/lib/auth", () => ({
  getAuth,
  prepareWebAuth: vi.fn(),
  resolveCurrentWebAuthMode: vi.fn(async () => { throw new Error("unscoped legacy must not read the persisted mode"); }),
}));
vi.mock("@/lib/enterprise-runtime", () => ({ getReadyWebAssembly: getReady }));
vi.mock("@megaui/database", async importOriginal => ({
  ...(await importOriginal<typeof import("@megaui/database")>()),
  getPool,
}));

import {
  FEISHU_SESSION_MAX_AGE_MS,
  createFeishuWebActorResolver,
  resolveWebActor,
  resolveWebSessionEntry,
} from "@/lib/enterprise-session";
import { authMiddleware } from "@/middlewares/auth";

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD_COOKIE = "better-auth.session_token=password-session";
const MANAGED = ["AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT",
  "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS", "PGBINARY", "PGSSLMODE",
  "PGSSLNEGOTIATION", "PGCLIENT_ENCODING", "PGREPLICATION"] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

function setEnvironment(values: Partial<Record<(typeof MANAGED)[number], string>>): void {
  for (const key of MANAGED) delete process.env[key];
  process.env.DATABASE_URL = "postgres://owned:synthetic@127.0.0.1:5432/owned";
  Object.assign(process.env, values);
}

/** NextRequest normalises the loopback host, so only the path and query are compared. */
function location(response: Response | undefined): string | undefined {
  const value = response?.headers.get("location");
  if (!value) return undefined;
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

function request(path: string, init: { method?: string; cookie?: string } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: init.cookie ? { cookie: init.cookie } : {},
  });
}

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

beforeEach(() => {
  getSession.mockClear();
  getAuth.mockClear();
  markerQuery.mockClear();
  getPool.mockClear();
  getReady.mockClear();
});

describe("FSL-126 AC7: legacy deployments keep their session behaviour", () => {
  const legacyEnvironments = [
    ["AUTH_MODE and AUTH_PROVIDER unset", {}],
    ["AUTH_MODE=legacy", { AUTH_MODE: "legacy" }],
    ["AUTH_PROVIDER=local", { AUTH_PROVIDER: "local" }],
    ["blank AUTH_PROVIDER", { AUTH_MODE: "legacy", AUTH_PROVIDER: "  " }],
  ] as const;

  it.each(legacyEnvironments)("%s: a session without a Feishu marker is the legacy actor", async (_label, values) => {
    setEnvironment(values);
    expect(resolveWebSessionEntry()).toBe("existing");
    await expect(resolveWebActor(new Headers({ cookie: PASSWORD_COOKIE }))).resolves.toEqual({
      kind: "legacy",
      userId: "fsl126-user",
      email: "user@example.test",
      sessionId: "fsl126-session",
    });
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({
      query: { disableCookieCache: true, disableRefresh: true },
    }));
    // The Feishu marker table is never consulted outside Feishu mode.
    expect(getPool).not.toHaveBeenCalled();
    expect(markerQuery).not.toHaveBeenCalled();
    await expect(resolveWebActor(new Headers())).resolves.toBeNull();
  });

  it.each(legacyEnvironments)("%s: the middleware decisions are unchanged", async (_label, values) => {
    setEnvironment(values);
    expect(await authMiddleware(request("/en/workspace", { cookie: PASSWORD_COOKIE }))).toBeUndefined();

    const page = await authMiddleware(request("/en/workspace"));
    expect(page?.status).toBe(302);
    expect(location(page)).toBe("/en/signin?callbackUrl=%2Fen%2Fworkspace");

    const api = await authMiddleware(request("/api/notifications"));
    expect(api?.status).toBe(401);

    // Every Better Auth operation and the legacy auth pages stay reachable.
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/get-session",
      "/api/auth/sign-out", "/api/auth/enterprise/request"]) {
      expect(await authMiddleware(request(path, { method: "POST" }))).toBeUndefined();
    }
    for (const path of ["/en/signup", "/en/forgot-password", "/en/reset-password", "/en/signin"]) {
      expect(await authMiddleware(request(path))).toBeUndefined();
    }
    const signedIn = await authMiddleware(request("/en/signin", { cookie: PASSWORD_COOKIE }));
    expect(signedIn?.status).toBe(302);
    expect(location(signedIn)).toBe("/en/workspace");
    expect(getPool).not.toHaveBeenCalled();
  });
});

describe("FSL-126 Feishu mode middleware surface", () => {
  it("exposes only get-session and sign-out of Better Auth, by exact path", async () => {
    setEnvironment({ AUTH_MODE: "enterprise", AUTH_PROVIDER: "feishu" });
    expect(resolveWebSessionEntry()).toBe("feishu");
    for (const path of ["/api/auth/get-session", "/api/auth/sign-out"]) {
      expect(await authMiddleware(request(path, { method: "POST" }))).toBeUndefined();
    }
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/sign-in/social",
      "/api/auth/enterprise/request", "/api/auth/enterprise/session", "/api/auth/get-session/",
      "/api/auth//get-session", "/api/auth/Get-Session", "/api/auth/get%2Dsession", "/API/auth/get-session",
      "/Api/Auth/sign-out", "/API/AUTH/sign-in/email"]) {
      const response = await authMiddleware(request(path, { method: "POST" }));
      expect(response?.status, path).toBe(404);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
    for (const path of ["/en/signup", "/en/forgot-password", "/en/reset-password"]) {
      expect((await authMiddleware(request(path)))?.status).toBe(404);
    }
    expect(await authMiddleware(request("/en"))).toBeUndefined();
    expect(await authMiddleware(request("/en/signin"))).toBeUndefined();
  });

  it("treats a password session without a marker row as signed out", async () => {
    setEnvironment({ AUTH_MODE: "enterprise", AUTH_PROVIDER: "feishu" });
    await expect(resolveWebActor(new Headers({ cookie: PASSWORD_COOKIE }))).resolves.toBeNull();
    expect(markerQuery).toHaveBeenCalledTimes(1);
    expect(markerQuery.mock.calls[0]).toEqual([expect.stringContaining("feishu_login_sessions"), ["fsl126-session", "fsl126-user"]]);
    const page = await authMiddleware(request("/en/workspace", { cookie: PASSWORD_COOKIE }));
    expect(location(page)).toBe("/en/signin?callbackUrl=%2Fen%2Fworkspace");
    expect(getReady).not.toHaveBeenCalled();
  });

  it("fails closed for an AUTH_MODE / AUTH_PROVIDER pair that resolveAuthMode refuses", async () => {
    for (const values of [{ AUTH_MODE: "legacy", AUTH_PROVIDER: "feishu" }, { AUTH_MODE: "enterprise", AUTH_PROVIDER: "local" },
      { AUTH_MODE: "enterprise", AUTH_PROVIDER: "other" }]) {
      setEnvironment(values);
      expect(resolveWebSessionEntry()).toBe("invalid");
      await expect(resolveWebActor(new Headers({ cookie: PASSWORD_COOKIE }))).resolves.toBeNull();
      expect((await authMiddleware(request("/api/auth/sign-in/email", { method: "POST" })))?.status).toBe(404);
      expect((await authMiddleware(request("/en/signup")))?.status).toBe(404);
      expect((await authMiddleware(request("/en/workspace", { cookie: PASSWORD_COOKIE })))?.status).toBe(302);
    }
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("FSL-126 Feishu session age decision", () => {
  const snapshot = { user: { id: "u" }, session: { id: "s" } };

  it("accepts a marker row aged zero to eight hours and rejects any other age", async () => {
    const aged = (ageMs: number) => createFeishuWebActorResolver({
      readSession: async () => snapshot,
      readFeishuSessionAgeMs: async () => ageMs,
    })(new Headers());
    await expect(aged(0)).resolves.toEqual({ kind: "feishu", userId: "u", sessionId: "s" });
    await expect(aged(FEISHU_SESSION_MAX_AGE_MS)).resolves.toMatchObject({ kind: "feishu" });
    await expect(aged(FEISHU_SESSION_MAX_AGE_MS + 1)).resolves.toBeNull();
    // A row dated in the future of the clock that wrote it is refused, not given extra time.
    await expect(aged(-1)).resolves.toBeNull();
    await expect(aged(Number.NaN)).resolves.toBeNull();
    await expect(aged(Number.POSITIVE_INFINITY)).resolves.toBeNull();
  });

  it("fails closed without a marker or when a read fails", async () => {
    const resolve = (ports: Partial<Parameters<typeof createFeishuWebActorResolver>[0]>) => createFeishuWebActorResolver({
      readSession: async () => snapshot,
      readFeishuSessionAgeMs: async () => 0,
      ...ports,
    })(new Headers());
    await expect(resolve({})).resolves.toMatchObject({ kind: "feishu" });
    await expect(resolve({ readFeishuSessionAgeMs: async () => null })).resolves.toBeNull();
    await expect(resolve({ readFeishuSessionAgeMs: async () => { throw new Error("database unavailable"); } })).resolves.toBeNull();
    await expect(resolve({ readSession: async () => { throw new Error("auth unavailable"); } })).resolves.toBeNull();
    await expect(resolve({ readSession: async () => null })).resolves.toBeNull();
  });
});
