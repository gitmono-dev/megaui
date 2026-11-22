// megaui-only (FSL-150): the Feishu-mode startup in `instrumentation.ts` `register()` against a
// one-shot PostgreSQL. AC5: in Feishu mode `register()` has finished one cleanup run before it
// returns, with no authentication request handled (no Better Auth instance exists yet); in
// legacy mode it starts no cleanup and builds nothing. FSL-132: there is no enterprise runtime
// startup any more, and `maintenance` or `enterprise` without AUTH_PROVIDER refuses the startup
// with `INVALID_AUTH_PROVIDER` before any cleanup.
// FSL-158 (GC-15): with NODE_ENV=production, `register()` refuses a runtime role that holds DDL
// (a superuser, or CREATE on schema public), and privileges it cannot read (no DATABASE_URL),
// with `DATABASE_ROLE_SCOPE_REJECTED` before the cleanup starts, and starts normally with a role granted only DML and sequence USAGE; in test it
// prints `DATABASE_ROLE_SCOPE_WARNING` for the superuser and continues.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabaseClient, createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, isDockerAvailable, type IsolatedPostgres } from "@megaui/database/test-support";

const spies = vi.hoisted(() => ({
  createAuth: undefined as unknown as ReturnType<typeof vi.fn>,
  startCleanup: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@megaui/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@megaui/auth")>();
  spies.createAuth = vi.fn(actual.createAuth);
  return { ...actual, createAuth: spies.createAuth };
});
vi.mock("@megaui/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@megaui/engine")>();
  spies.startCleanup = vi.fn(actual.startFeishuLoginCleanup);
  return { ...actual, startFeishuLoginCleanup: spies.startCleanup };
});
import { register } from "@/instrumentation";
import { stopFeishuWebRuntime } from "@/lib/auth";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/web] feishu-login-wiring.test.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const MANAGED = ["NEXT_RUNTIME", "AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "FEISHU_APP_ID", "FEISHU_APP_SECRET",
  "ENTERPRISE_OTP_HMAC_KEY", "FEISHU_PROVIDER", "FEISHU_SIMULATOR_ORIGIN"] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

let isolated: IsolatedPostgres | undefined;
let database: DatabaseClient | undefined;
const savedNodeEnv = process.env.NODE_ENV;
const ROLE_PASSWORD = randomBytes(16).toString("hex");

/** The connection string of the one-shot database as `role`. */
function urlAs(role: string): string {
  const url = new URL(isolated!.databaseUrl);
  url.username = role;
  url.password = ROLE_PASSWORD;
  return url.toString();
}

/** Points the shared database client of `register()` at `url` and sets NODE_ENV. */
async function runAs(url: string, nodeEnv: string): Promise<void> {
  await closeDatabaseClient();
  process.env.DATABASE_URL = url;
  Reflect.set(process.env, "NODE_ENV", nodeEnv);
}

const hex = () => randomBytes(32).toString("hex");

/** An `active` row (every sensitive field set) that expired five minutes ago. */
async function seedExpiredRow(): Promise<string> {
  const id = randomUUID();
  await database!.pool.query(
    `insert into feishu_login_codes
       (id, flow_hash, flow_seq, email_hmac, email_seq, state, email, open_id, display_name, code_hmac,
        failed_attempts, expires_at, created_at)
     values ($1, $2, 1, $3, 1, 'active', 'alice@example.com', 'ou_mock_alice', 'Mock Alice', $4, 0,
             now() - interval '5 minutes', now() - interval '10 minutes')`,
    [id, hex(), hex(), hex()],
  );
  return id;
}

async function readRow(id: string) {
  return (await database!.pool.query<{ state: string; email: string | null; open_id: string | null;
    display_name: string | null; code_hmac: string | null }>(
    "select state, email, open_id, display_name, code_hmac from feishu_login_codes where id = $1", [id],
  )).rows[0];
}

function setMode(mode: string | undefined, provider: string | undefined): void {
  if (mode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = mode;
  if (provider === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = provider;
}

describe("FSL-150 register() in Feishu mode", () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    database = createDatabaseClient({ connectionString: isolated.databaseUrl, max: 2, onPoolError: () => {} });
    for (const key of MANAGED) delete process.env[key];
    Object.assign(process.env, {
      NEXT_RUNTIME: "nodejs",
      DATABASE_URL: isolated.databaseUrl,
      FEISHU_APP_ID: "cli_fsl150_wiring",
      FEISHU_APP_SECRET: "fsl150-wiring-secret",
      ENTERPRISE_OTP_HMAC_KEY: randomBytes(32).toString("base64url"),
    });
    // FSL-158: a role that may CREATE in schema public, and the runtime role of a deployment
    // (DML on every table, sequence USAGE).
    const db = `"${isolated.databaseName}"`;
    for (const role of ["wiring_public_create", "wiring_runtime"]) {
      await database.pool.query(`create role ${role} login password '${ROLE_PASSWORD}'`);
      await database.pool.query(`grant connect on database ${db} to ${role}`);
      await database.pool.query(`grant usage on schema public to ${role}`);
    }
    await database.pool.query("grant create on schema public to wiring_public_create");
    await database.pool.query("grant select, insert, update, delete on all tables in schema public to wiring_runtime");
    await database.pool.query("grant usage on all sequences in schema public to wiring_runtime");
  }, 180_000);

  beforeEach(async () => {
    await database!.pool.query("delete from feishu_login_codes");
    spies.createAuth.mockClear();
    spies.startCleanup.mockClear();
  });

  afterEach(async () => {
    await stopFeishuWebRuntime();
    if (process.env.DATABASE_URL !== isolated!.databaseUrl || process.env.NODE_ENV !== savedNodeEnv) {
      await runAs(isolated!.databaseUrl, savedNodeEnv ?? "test");
    }
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const end of [() => stopFeishuWebRuntime(), () => closeDatabaseClient(), () => database?.close(),
      () => isolated?.destroy()]) {
      try { await end(); } catch (error) { errors.push(error); }
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    Reflect.set(process.env, "NODE_ENV", savedNodeEnv);
    if (errors.length) throw new AggregateError(errors, "FSL-150 wiring cleanup failed");
  }, 120_000);

  it("AC5: register() has finished one cleanup before it returns, with no auth request handled", async () => {
    setMode("enterprise", "feishu");
    const id = await seedExpiredRow();
    expect((await readRow(id))?.state).toBe("active");
    const signals = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };

    await register();

    // The expired row is void with its sensitive fields cleared by the time register() returns.
    expect(await readRow(id)).toEqual({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
    expect(spies.startCleanup).toHaveBeenCalledTimes(1);
    // No Better Auth instance exists yet, so no authentication request can have been handled,
    // and the enterprise runtime is not started.
    expect(spies.createAuth).not.toHaveBeenCalled();
    // No signal handler was installed.
    expect(process.listenerCount("SIGTERM")).toBe(signals.term);
    expect(process.listenerCount("SIGINT")).toBe(signals.int);
  }, 60_000);

  it("a second register() in the same process starts no second schedule", async () => {
    setMode("enterprise", "feishu");
    await register();
    await register();
    expect(spies.startCleanup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("an invalid Feishu login configuration refuses the startup before any cleanup", async () => {
    setMode("enterprise", "feishu");
    const secret = process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_APP_SECRET = " padded ";
    try {
      await expect(register()).rejects.toMatchObject({ code: "INVALID_FEISHU_LOGIN_CONFIG", keys: ["FEISHU_APP_SECRET"] });
    } finally {
      process.env.FEISHU_APP_SECRET = secret;
    }
    expect(spies.startCleanup).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    ["legacy", undefined],
    ["legacy", "local"],
    [undefined, undefined],
  ] as const)("AUTH_MODE=%s AUTH_PROVIDER=%s starts no cleanup and builds no Auth instance", async (mode, provider) => {
    setMode(mode, provider);
    const id = await seedExpiredRow();

    await register();

    expect(spies.startCleanup).not.toHaveBeenCalled();
    expect(spies.createAuth).not.toHaveBeenCalled();
    expect((await readRow(id))?.state).toBe("active");
  }, 60_000);

  it.each([
    ["enterprise", undefined],
    ["enterprise", " "],
    ["maintenance", undefined],
    ["maintenance", "local"],
  ] as const)("FSL-132: AUTH_MODE=%s AUTH_PROVIDER=%s refuses the startup before any cleanup", async (mode, provider) => {
    setMode(mode, provider);
    const id = await seedExpiredRow();

    await expect(register()).rejects.toMatchObject({ name: "AuthModeError", code: "INVALID_AUTH_PROVIDER" });

    expect(spies.startCleanup).not.toHaveBeenCalled();
    expect(spies.createAuth).not.toHaveBeenCalled();
    expect((await readRow(id))?.state).toBe("active");
  }, 60_000);
  it.each([
    ["AC1 superuser", "superuser"],
    ["AC4 CREATE on schema public", "wiring_public_create"],
  ] as const)("FSL-158 %s: NODE_ENV=production refuses the startup before the cleanup", async (_label, role) => {
    setMode("enterprise", "feishu");
    const id = await seedExpiredRow();
    await runAs(role === "superuser" ? isolated!.databaseUrl : urlAs(role), "production");

    const refusal = await register().then(() => undefined, (error: unknown) => error);

    expect(refusal).toMatchObject({ name: "DatabaseRoleScopeError", code: "DATABASE_ROLE_SCOPE_REJECTED" });
    expect((refusal as Error).message).not.toContain(ROLE_PASSWORD);
    expect((refusal as Error).message).not.toContain(isolated!.databaseName);
    expect(spies.startCleanup).not.toHaveBeenCalled();
    expect(spies.createAuth).not.toHaveBeenCalled();
    expect((await readRow(id))?.state).toBe("active");
  }, 60_000);

  it("FSL-158 AC5: NODE_ENV=production refuses the startup when the privileges cannot be read", async () => {
    setMode("enterprise", "feishu");
    const id = await seedExpiredRow();
    await runAs(isolated!.databaseUrl, "production");
    delete process.env.DATABASE_URL;

    await expect(register()).rejects.toMatchObject({ code: "DATABASE_ROLE_SCOPE_REJECTED", unreadable: true });

    expect(spies.startCleanup).not.toHaveBeenCalled();
    expect(spies.createAuth).not.toHaveBeenCalled();
    expect((await readRow(id))?.state).toBe("active");
  }, 60_000);

  it("FSL-158 AC6: NODE_ENV=production starts normally with a DML-only runtime role", async () => {
    setMode("enterprise", "feishu");
    const id = await seedExpiredRow();
    await runAs(urlAs("wiring_runtime"), "production");
    const warn = vi.spyOn(console, "warn");
    try {
      await register();
      expect(warn.mock.calls.flat().join("\n")).not.toContain("DATABASE_ROLE_SCOPE");
    } finally {
      warn.mockRestore();
    }

    expect(spies.startCleanup).toHaveBeenCalledTimes(1);
    expect(await readRow(id)).toEqual({ state: "void", email: null, open_id: null, display_name: null, code_hmac: null });
  }, 60_000);

  it("FSL-158 AC7: NODE_ENV=test warns about the superuser and continues", async () => {
    setMode("enterprise", "feishu");
    const id = await seedExpiredRow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await register();
      const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("DATABASE_ROLE_SCOPE_WARNING"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("facts=superuser");
      expect(lines[0]).not.toContain(isolated!.databaseName);
    } finally {
      warn.mockRestore();
    }
    expect(spies.startCleanup).toHaveBeenCalledTimes(1);
    expect((await readRow(id))?.state).toBe("void");
  }, 60_000);
});
