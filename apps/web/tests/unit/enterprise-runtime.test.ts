// megaui-only (FS-93): no real environment, sockets or database in configuration tests.
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedWebDatabaseUrl, readEnterpriseWebConfig, requiresEnterpriseWebRuntime } from "@/lib/enterprise-config";

const base = { DATABASE_URL: "postgres://owned:synthetic@127.0.0.1:5432/owned" };
const enterprise = { ...base, AUTH_MODE: "enterprise", ENTERPRISE_PROCESS_ROLE: "web",
  ENTERPRISE_OWNER_FINGERPRINT: "owned", ENTERPRISE_DB_INSTANCE_ID: "owned-instance", ENTERPRISE_DEPLOYMENT_ROLE: "test",
  FEISHU_TENANT_KEY: "owned-tenant", FEISHU_APP_ID: "owned-app", ENTERPRISE_IP_HMAC_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
  ENTERPRISE_TRUSTED_PROXY_CIDRS: "[]", BETTER_AUTH_URL: "http://127.0.0.1:3000" };

describe("trusted Web runtime configuration", () => {
  it("keeps unscoped legacy independent and disables inactive pairing configuration", () => {
    expect(requiresEnterpriseWebRuntime({})).toBe(false);
    expect(readEnterpriseWebConfig(base)).toMatchObject({ mode: "legacy", scope: undefined, pairing: undefined });
    expect(readEnterpriseWebConfig({ ...enterprise, AUTH_MODE: "maintenance", FEISHU_TENANT_KEY: undefined,
      ENTERPRISE_IP_HMAC_MASTER_KEY: undefined, ENTERPRISE_TRUSTED_PROXY_CIDRS: undefined })).toMatchObject({ mode: "maintenance", pairing: undefined });
  });
  it.each(["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"])("requires a complete scope when %s is even empty", key => {
    expect(requiresEnterpriseWebRuntime({ [key]: "" })).toBe(true);
    expect(() => readEnterpriseWebConfig({ ...base, [key]: "" })).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
  });
  it.each(["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "FEISHU_TENANT_KEY", "FEISHU_APP_ID"])("rejects absent/empty/oversized/control-bearing %s", key => {
    for (const value of [undefined, "", "a".repeat(257), "bad value", "bad\n", "bad\x7f"]) {
      expect(() => readEnterpriseWebConfig({ ...enterprise, [key]: value })).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
    }
  });
  it("rejects role/default/bootstrap shortcuts and unknown modes", () => {
    for (const input of [{ ENTERPRISE_PROCESS_ROLE: "test" }, { ENTERPRISE_DEPLOYMENT_ROLE: "staging" },
      { ENTERPRISE_APPROVED_TARGETS: "owned:owned-instance:test" }, { AUTH_MODE: "unknown" }]) {
      expect(() => readEnterpriseWebConfig({ ...enterprise, ...input })).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
    }
  });
  it.each(["http://localhost:3000", "http://127.1:3000", "http://2130706433:3000", "http://0x7f000001:3000",
    "https://user:password@example.test", "https://example.test/path", "https://example.test?", "https://example.test#",
    "https://example.test/?secret=redacted", "https://example.test/#redacted", "https://example.test/path/..",
    "https://example.test/.", "https:\\\\example.test", "file:///tmp/auth"])("rejects noncanonical auth origin %s", value => {
    expect(() => readEnterpriseWebConfig({ ...enterprise, BETTER_AUTH_URL: value })).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
  });
  it("permits literal loopback only for test/development and HTTPS elsewhere", () => {
    expect(readEnterpriseWebConfig({ ...enterprise, BETTER_AUTH_URL: "http://[::1]:3000/" }).origin).toBe("http://[::1]:3000");
    for (const environment of ["canary", "production"]) {
      expect(() => readEnterpriseWebConfig({ ...enterprise, ENTERPRISE_DEPLOYMENT_ROLE: environment })).toThrow();
      expect(readEnterpriseWebConfig({ ...enterprise, ENTERPRISE_DEPLOYMENT_ROLE: environment,
        BETTER_AUTH_URL: "https://login.example.test/" }).origin).toBe("https://login.example.test");
    }
  });
  it("requires canonical 32-byte key encoding and bounded explicit proxy arrays", () => {
    for (const value of [undefined, "", "a".repeat(42), "a".repeat(43), `${enterprise.ENTERPRISE_IP_HMAC_MASTER_KEY}=`, "!".repeat(43)]) {
      expect(() => readEnterpriseWebConfig({ ...enterprise, ENTERPRISE_IP_HMAC_MASTER_KEY: value })).toThrow();
    }
    for (const value of [undefined, "", "{}", "null", "[0]", JSON.stringify(Array(65).fill("127.0.0.1/32")), " ".repeat(8193)]) {
      expect(() => readEnterpriseWebConfig({ ...enterprise, ENTERPRISE_TRUSTED_PROXY_CIDRS: value })).toThrow();
    }
    const config = readEnterpriseWebConfig(enterprise);
    expect(config.pairing?.proxyCidrs).toEqual([]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.scope)).toBe(true);
    expect(Object.isFrozen(config.pairing?.proxyCidrs)).toBe(true);
  });
  it("replaces every controllable timeout/options override and forbids target ambiguity", () => {
    expect(new URL(boundedWebDatabaseUrl("postgres://u:p@localhost/db")).port).toBe("5432");
    const result = new URL(boundedWebDatabaseUrl(`${base.DATABASE_URL}?statement_timeout=0&query_timeout=0&lock_timeout=0&idle_in_transaction_session_timeout=0&options=evil&pipeline=true&connectionTimeoutMillis=0&connect_timeout=0`));
    expect(result.searchParams.get("statement_timeout")).toBe("3000");
    expect(result.searchParams.get("query_timeout")).toBe("3000");
    expect(result.searchParams.get("lock_timeout")).toBe("1000");
    expect(result.searchParams.get("idle_in_transaction_session_timeout")).toBe("5000");
    expect(result.searchParams.get("options")).toContain("statement_timeout=3000");
    expect(result.searchParams.has("pipeline")).toBe(false);
    for (const suffix of ["?host=elsewhere", "?user=admin", "?database=other", "?port=5433", "?unknown=value", "?sslmode=require&sslmode=disable", "#fragment"]) {
      expect(() => boundedWebDatabaseUrl(base.DATABASE_URL + suffix)).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
    }
    for (const value of [undefined, "", "postgres://localhost/db", "postgres://u:p@localhost/", "postgres://u:p@localhost/db%00", "https://u:p@localhost/db"]) {
      expect(() => boundedWebDatabaseUrl(value)).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
    }
  });
  it("documents scope as opt-in and keeps the IP key a nonusable sample placeholder", async () => {
    const sample = await readFile(new URL("../../../../env.example", import.meta.url), "utf8");
    const entries = Object.fromEntries(sample.split("\n").filter(line => line && !line.startsWith("#") && line.includes("="))
      .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(entries.AUTH_MODE).toBe("legacy");
    expect(requiresEnterpriseWebRuntime(entries)).toBe(false);
    expect(entries.ENTERPRISE_IP_HMAC_MASTER_KEY).toMatch(/^replace-with-/);
    expect(() => readEnterpriseWebConfig({ ...enterprise, ENTERPRISE_IP_HMAC_MASTER_KEY: entries.ENTERPRISE_IP_HMAC_MASTER_KEY })).toThrow();
  });
  it.each(["PGBINARY", "PGSSLMODE", "PGSSLNEGOTIATION", "PGCLIENT_ENCODING", "PGREPLICATION"])("rejects effective driver environment %s in favor of fixed URL configuration", key => {
    expect(() => readEnterpriseWebConfig({ ...base, [key]: "changed" })).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
  });
  it.each(["sslcert", "sslkey", "sslrootcert"])("rejects synchronous file parameter %s before any Pool can be constructed", key => {
    expect(() => boundedWebDatabaseUrl(`${base.DATABASE_URL}?${key}=/synthetic/blocking-pipe`)).toThrow("ENTERPRISE_WEB_CONFIG_INVALID");
  });
});

const registryKey = Symbol.for("megaui.web.enterprise-runtime");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Web registry state invariants (injected clocks and dependencies only)", () => {
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.doUnmock("@megaui/database");
    Reflect.deleteProperty(globalThis, registryKey); vi.resetModules();
  });
  async function fixture(context = Promise.resolve({})) {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "legacy"); vi.stubEnv("DATABASE_URL", base.DATABASE_URL);
    for (const key of ["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT", "ENTERPRISE_DB_INSTANCE_ID",
      "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"]) vi.stubEnv(key, undefined);
    const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() });
    const pool = Object.assign(new EventEmitter(), { connect: vi.fn(async () => client) });
    const close = vi.fn(async () => { client.emit("end"); });
    const factory = vi.fn(() => ({ pool, db: {}, close }));
    const auth = { $context: context } as unknown as import("@megaui/auth").Auth;
    const prepare = vi.fn(() => ({ fingerprint: "synthetic-auth-config", create: () => auth }));
    vi.doMock("@megaui/database", async importOriginal => ({ ...await importOriginal<object>(), createDatabaseClient: factory }));
    const runtime = await import("@/lib/enterprise-runtime");
    return { runtime, initialize: () => runtime.initializeWebAssembly(prepare), factory, prepare, close, client, pool, auth };
  }
  it("imports without reading required Auth settings or creating a Pool", async () => {
    const f = await fixture();
    expect(f.factory).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    expect(f.runtime.getReadyWebAssembly()).toBeUndefined();
  });
  it("shares initialization and withholds ready until the real Auth initialization promise resolves", async () => {
    const context = deferred<object>(); const f = await fixture(context.promise);
    const first = f.initialize();
    expect(f.initialize()).toBe(first);
    await Promise.resolve();
    expect(() => f.runtime.getReadyWebAssembly()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    context.resolve({});
    const assembly = await first;
    expect(assembly.auth).toBe(f.auth); expect(f.factory).toHaveBeenCalledTimes(1);
    expect(await f.runtime.closeEnterpriseWebRuntime()).toEqual({ kind: "closed" });
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("enforces the ten-second initialization deadline and retains failed cleanup after late completion", async () => {
    const context = deferred<object>(); const f = await fixture(context.promise);
    vi.useFakeTimers();
    const initialized = f.initialize();
    const rejected = expect(initialized).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    const closed = f.runtime.closeEnterpriseWebRuntime();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await closed).toEqual({ kind: "cleanup-pending" });
    context.resolve({}); await vi.advanceTimersByTimeAsync(1);
    expect(await f.runtime.closeEnterpriseWebRuntime()).toEqual({ kind: "cleanup-pending" });
    expect(() => f.runtime.getReadyWebAssembly()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("caches a failed close and never invokes Pool cleanup twice", async () => {
    const f = await fixture(); await f.initialize();
    f.close.mockRejectedValueOnce(new Error("synthetic cleanup error"));
    const first = f.runtime.closeEnterpriseWebRuntime();
    expect(f.runtime.closeEnterpriseWebRuntime()).toBe(first);
    expect(await first).toEqual({ kind: "cleanup-pending" }); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it("rejects a different bundle protocol without creating an alternative registry", async () => {
    const f = await fixture();
    Reflect.set(globalThis, registryKey, { protocol: "different-protocol", state: "ready" });
    await expect(f.initialize()).rejects.toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    expect(() => f.runtime.getReadyWebAssembly()).toThrow("ENTERPRISE_WEB_UNAVAILABLE");
    expect(f.factory).not.toHaveBeenCalled();
  });
});
