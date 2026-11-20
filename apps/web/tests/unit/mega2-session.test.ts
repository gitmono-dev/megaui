// megaui-only (FSL-156): the Mega2 `get-session` projection outside Feishu mode is unchanged,
// and the Feishu branch is fail-closed. No database or socket: Better Auth and the shared
// Pool are replaced by spies, so the legacy cases can assert that the principal conflict
// query is never issued.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const RAW = vi.hoisted(() => ({
  user: { id: "legacy-user", name: "Ada Lovelace", email: "ada@example.test", image: null as string | null },
  session: { id: "legacy-session", expiresAt: new Date("2030-01-01T00:00:00Z") },
}));
const getSession = vi.hoisted(() => vi.fn(async ({ headers }: { headers: Headers }) =>
  headers.get("cookie")?.includes("legacy-session") ? RAW : null));
const getAuth = vi.hoisted(() => vi.fn(() => ({ api: { getSession } })));
const poolQuery = vi.hoisted(() => vi.fn(async (): Promise<{ rows: unknown[] }> => {
  throw new Error("outside Feishu mode no query is issued");
}));
const getPool = vi.hoisted(() => vi.fn(() => ({ query: poolQuery })));

vi.mock("@/lib/auth", () => ({
  getAuth,
  prepareWebAuth: vi.fn(),
  resolveCurrentWebAuthMode: vi.fn(async () => { throw new Error("unscoped legacy must not read the persisted mode"); }),
}));
vi.mock("@/lib/enterprise-runtime", () => ({ getReadyWebAssembly: vi.fn(() => null) }));
vi.mock("@megaui/database", async importOriginal => ({
  ...(await importOriginal<typeof import("@megaui/database")>()),
  getPool,
}));

import type { WebActor } from "@/lib/enterprise-session";
import {
  FEISHU_LOGIN_PRINCIPAL_CONFLICT,
  createMega2SessionResponseHandler,
  deriveMega2Actor,
  feishuMega2Principal,
  getMega2SessionResponse,
  projectMega2Session,
  type Mega2PrincipalCandidate,
  type Mega2RawSession,
} from "@/lib/mega2-session";

const MANAGED = ["AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT",
  "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS", "ENTERPRISE_INSTANCE_ID",
  "ENTERPRISE_TENANT_KEY", "ENTERPRISE_DEPARTMENT_IDS", "FEISHU_APP_ID"] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

beforeEach(() => {
  getSession.mockClear();
  getAuth.mockClear();
  poolQuery.mockClear();
  getPool.mockClear();
});

/**
 * The projection exactly as it was before FSL-156 (`apps/web/lib/mega2-session.ts` at the
 * parent commit), kept verbatim as the regression oracle for legacy and enterprise actors.
 */
function preFsl156Projection(session: Mega2RawSession | null, actor: WebActor | null) {
  const rustTrim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const derive = (input: { name: string; email: string | null }) => {
    if (rustTrim(input.name) !== "") return input.name;
    const at = input.email?.indexOf("@") ?? -1;
    const localPart = at < 0 ? undefined : rustTrim(input.email!.slice(0, at));
    return localPart === "" ? undefined : localPart;
  };
  if (!session || !actor || session.user.id !== actor.userId || session.session.id !== actor.sessionId) return null;
  const name = actor.kind === "enterprise"
    ? actor.backendUsername
    : derive({ name: session.user.name, email: session.user.email });
  if (!name) return null;
  return {
    session: { id: session.session.id, expiresAt: session.session.expiresAt },
    user: {
      id: session.user.id,
      name,
      email: actor.kind === "enterprise" ? actor.email ?? null : session.user.email,
      image: session.user.image,
      banned: false as const,
    },
  };
}

function raw(name: string, email: string | null, image: string | null = null): Mega2RawSession {
  return {
    session: { id: "s-1", expiresAt: new Date("2030-01-01T00:00:00Z") },
    user: { id: "u-1", name, email, image },
  };
}

const NAMES_AND_EMAILS: ReadonlyArray<readonly [string, string | null]> = [
  ["Ada Lovelace", "ada@example.test"],
  ["  padded  ", "padded@example.test"],
  ["\u0085\t", "  ada  @example.test"],
  ["\u3000", "\u2003ops\u00a0@example.test"],
  ["", "first@second@example.test"],
  ["", "no-at-sign"],
  ["", " @example.test"],
  ["", null],
  ["fs_u-1", "fs_u-1@example.test"],
  ["张三", "zhang.san@example.test"],
];

describe("FSL-156 AC6: legacy projection is unchanged", () => {
  it("projects legacy and enterprise actors exactly as before FSL-156", () => {
    const actors: WebActor[] = [
      { kind: "legacy", userId: "u-1", sessionId: "s-1" },
      { kind: "legacy", userId: "u-1", email: "other@example.test", sessionId: "s-1" },
      { kind: "legacy", userId: "u-2", sessionId: "s-1" },
      { kind: "legacy", userId: "u-1", sessionId: "s-2" },
      { kind: "enterprise", userId: "u-1", identityId: "i", authEpoch: 1, backendUsername: "Frozen.User", email: "n@example.test", sessionId: "s-1" },
      { kind: "enterprise", userId: "u-1", identityId: "i", authEpoch: 1, backendUsername: "", sessionId: "s-1" },
    ];
    for (const [name, email] of NAMES_AND_EMAILS) {
      for (const image of [null, "https://img.example.test/a.png"]) {
        const session = raw(name, email, image);
        for (const actor of actors) {
          expect(projectMega2Session(session, actor)).toEqual(preFsl156Projection(session, actor));
        }
      }
    }
    expect(projectMega2Session(null, actors[0]!)).toBeNull();
    expect(projectMega2Session(raw("Ada", "ada@example.test"), null)).toBeNull();
  });

  it("keeps deriveMega2Actor byte-stable", () => {
    expect(deriveMega2Actor({ name: "\u0085\t", email: "  ada  @example.test" })).toBe("ada");
    expect(deriveMega2Actor({ name: "  padded  ", email: "x@example.test" })).toBe("  padded  ");
    expect(deriveMega2Actor({ name: "", email: "no-at-sign" })).toBeUndefined();
    expect(deriveMega2Actor({ name: "Name", email: null, frozenBackendUsername: "frozen" })).toBe("frozen");
  });

  it("the handler projects a legacy actor without the principal check or log", async () => {
    const readPrincipalCandidates = vi.fn(async () => []);
    const log = vi.fn();
    const session = raw("Ada Lovelace", "ada@example.test");
    const handler = createMega2SessionResponseHandler({
      readSession: async () => session,
      resolveActor: async () => ({ kind: "legacy", userId: "u-1", sessionId: "s-1" }),
      readPrincipalCandidates,
      log,
    });
    const response = await handler(new Request("http://127.0.0.1:3000/api/auth/get-session"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(preFsl156Projection(session, {
      kind: "legacy", userId: "u-1", sessionId: "s-1",
    }))));
    expect(readPrincipalCandidates).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  for (const environment of [
    { label: "AUTH_PROVIDER unset", values: {} },
    { label: "AUTH_PROVIDER blank", values: { AUTH_PROVIDER: "  " } },
    { label: "AUTH_PROVIDER=local", values: { AUTH_PROVIDER: "local" } },
    { label: "AUTH_MODE=legacy, AUTH_PROVIDER=local", values: { AUTH_MODE: "legacy", AUTH_PROVIDER: "local" } },
  ]) {
    it(`the production get-session keeps the legacy projection (${environment.label})`, async () => {
      for (const key of MANAGED) delete process.env[key];
      process.env.DATABASE_URL = "postgres://owned:synthetic@127.0.0.1:5432/owned";
      Object.assign(process.env, environment.values);
      const response = await getMega2SessionResponse(new Request("http://127.0.0.1:3000/api/auth/get-session", {
        headers: { cookie: "better-auth.session_token=legacy-session" },
      }));
      const expected = preFsl156Projection(RAW, { kind: "legacy", userId: RAW.user.id, sessionId: RAW.session.id });
      expect(await response.json()).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(getPool).not.toHaveBeenCalled();
      expect(poolQuery).not.toHaveBeenCalled();
    });
  }
});

describe("FSL-156: the Feishu branch is fail-closed", () => {
  const actor: WebActor = { kind: "feishu", userId: "u-1", email: "m@example.test", sessionId: "s-1" };
  const session = raw("Member", "m@example.test");
  const principal = feishuMega2Principal("u-1");

  async function project(
    candidates: (() => Promise<readonly Mega2PrincipalCandidate[]>) | undefined,
    log = vi.fn(),
    sessionValue: Mega2RawSession | null = session,
  ) {
    const handler = createMega2SessionResponseHandler({
      readSession: async () => sessionValue,
      resolveActor: async () => actor,
      ...(candidates ? { readPrincipalCandidates: candidates } : {}),
      log,
    });
    return { body: await (await handler(new Request("http://127.0.0.1:3000/api/auth/get-session"))).json(), log };
  }

  it("projects fs_<user ID> when no other user derives it", async () => {
    const read = vi.fn(async () => [
      { id: "u-1", name: principal, email: null, frozenBackendUsername: null },
      { id: "u-2", name: `${principal}x`, email: null, frozenBackendUsername: null },
      { id: "u-3", name: principal, email: null, frozenBackendUsername: "frozen" },
      { id: "u-4", name: "Named", email: `${principal}@example.test`, frozenBackendUsername: null },
    ]);
    const { body, log } = await project(read);
    expect(body).toMatchObject({ user: { id: "u-1", name: "fs_u-1", email: "m@example.test", banned: false } });
    expect(read).toHaveBeenCalledWith("fs_u-1", "u-1");
    expect(log).not.toHaveBeenCalled();
  });

  for (const [label, candidate] of [
    ["name", { id: "u-2", name: principal, email: "x@example.test", frozenBackendUsername: null }],
    ["email local part", { id: "u-2", name: "\u0085 ", email: `\t${principal}\u3000@example.test`, frozenBackendUsername: null }],
    ["frozen enterprise principal", { id: "u-2", name: "Other", email: "x@example.test", frozenBackendUsername: principal }],
  ] as const) {
    it(`a conflict through the ${label} projects null and logs the key`, async () => {
      const { body, log } = await project(async () => [candidate]);
      expect(body).toBeNull();
      expect(log.mock.calls).toEqual([[FEISHU_LOGIN_PRINCIPAL_CONFLICT]]);
    });
  }

  it("a failed or missing check projects null and logs the key", async () => {
    for (const read of [
      async () => { throw new Error("db down"); },
      async () => null as never,
      async () => [{ id: 1 }] as never,
      undefined,
    ]) {
      const { body, log } = await project(read);
      expect(body).toBeNull();
      expect(log.mock.calls).toEqual([[FEISHU_LOGIN_PRINCIPAL_CONFLICT]]);
    }
  });

  it("the default logger is console.warn with the key only, and a throwing logger changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handler = createMega2SessionResponseHandler({
        readSession: async () => session,
        resolveActor: async () => actor,
      });
      expect(await (await handler(new Request("http://127.0.0.1:3000/api/auth/get-session"))).json()).toBeNull();
      expect(warn.mock.calls).toEqual([[FEISHU_LOGIN_PRINCIPAL_CONFLICT]]);
    } finally {
      warn.mockRestore();
    }
    const { body } = await project(async () => [{ id: "u-2", name: principal, email: null, frozenBackendUsername: null }],
      vi.fn(() => { throw new Error("logger down"); }));
    expect(body).toBeNull();
  });

  it("a session that does not match the actor is null without a check", async () => {
    const read = vi.fn(async () => []);
    const { body, log } = await project(read, vi.fn(), { ...session, session: { ...session.session, id: "s-other" } });
    expect(body).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("projectMega2Session refuses a Feishu actor unless the check passed", () => {
    expect(projectMega2Session(session, actor)).toBeNull();
    expect(projectMega2Session(session, actor, { feishuPrincipalChecked: true })?.user.name).toBe("fs_u-1");
  });
});
