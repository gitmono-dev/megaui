// megaui-only (FIX-FS-02): one legacy BFF fixture per test file/worker.
// The bootstrap writer owns this throwaway PG; routes and mint use a DML role.
import { randomBytes } from "node:crypto";
import { closeDatabaseClient, type Database } from "@megaui/database";
import { seedMegaDatabase } from "@megaui/engine/seed";
import { OwnedWeb } from "./owned-web";

const SETTINGS = ["DATABASE_URL", "AUTH_MODE", "MEGAUI_APP_NAME", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
  "APP_BASE_URL", "BETTER_AUTH_TRUSTED_ORIGINS", "EMAIL_PROVIDER", "EMAIL_DEFAULT_FROM", "S3_PUBLIC_URL",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"];
let active = false;

async function boundedClose(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned contract parent Pool cleanup pending")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Creating the lifetime is inert; register close in afterAll before calling start. */
export function ownedContractFixture(options: { seed?: (database: Database) => Promise<unknown> } = {}) {
  let state: "idle" | "starting" | "ready" | "closing" | "closed" = "idle";
  let owner: OwnedWeb | undefined;
  let work: Promise<void> | undefined;
  let started: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let ownsSlot = false;
  const saved = new Map<string, string | undefined>();

  function close(): Promise<void> {
    if (cleanup) return cleanup;
    state = "closing";
    cleanup = (async () => {
      const failures: unknown[] = [];
      // A timed-out beforeAll may still be allocating. Await its actual terminal
      // result before disposing, so late setup cannot orphan a directory or PG.
      await work?.catch(() => undefined);
      if (ownsSlot) {
        try { await boundedClose(closeDatabaseClient()); } catch (error) { failures.push(error); }
      }
      try { await owner?.close(); } catch (error) { failures.push(error); }
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (ownsSlot) active = false;
      state = "closed";
      if (failures.length) throw new AggregateError(failures, "Owned contract cleanup failed");
    })();
    return cleanup;
  }

  function start(): Promise<void> {
    if (started) return started;
    if (state !== "idle" || active) return Promise.reject(new Error("Owned contract lifetime is unavailable"));
    state = "starting"; active = true; ownsSlot = true;
    for (const key of new Set([...SETTINGS, ...Object.keys(process.env).filter(key => key.startsWith("ENTERPRISE_"))])) {
      saved.set(key, process.env[key]);
    }
    work = (async () => {
      owner = await OwnedWeb.create();
      if (state !== "starting") throw new Error("Owned contract setup was closed");
      const bootstrap = owner.createDatabaseObserver();
      await (options.seed ?? seedMegaDatabase)(bootstrap.db);
      if (state !== "starting") throw new Error("Owned contract setup was closed");
      const url = new URL(owner.env.DATABASE_URL!);
      const database = decodeURIComponent(url.pathname.slice(1)).replaceAll('"', '""');
      const password = randomBytes(24).toString("hex");
      await bootstrap.pool.query(`create role owned_contract_web login password '${password}';
        revoke create on database "${database}" from public;
        revoke create on schema public from public;
        grant connect on database "${database}" to owned_contract_web;
        grant usage on schema public to owned_contract_web;
        grant select,insert,update,delete on all tables in schema public to owned_contract_web;
        grant usage,select on all sequences in schema public to owned_contract_web`);
      await bootstrap.close();
      url.username = "owned_contract_web"; url.password = password;
      owner.env.DATABASE_URL = url.toString();
      if (state !== "starting") throw new Error("Owned contract setup was closed");
      for (const key of saved.keys()) {
        const value = owner.env[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      state = "ready";
    })();
    started = work.catch(async error => {
      try { await close(); }
      catch (failure) { throw new AggregateError([error, failure], "Owned contract setup and cleanup failed", { cause: failure }); }
      throw error;
    });
    return started;
  }

  async function mint(): Promise<string> {
    if (state !== "ready" || !owner) throw new Error("Owned contract is not ready");
    const result = await owner.run("pnpm", ["exec", "tsx", "apps/web/tests/e2e/helpers/mint-session-cli.ts"]);
    if (state !== "ready") throw new Error("Owned contract was closed during mint");
    // The legacy helper also returns a password. Keep all raw output private and
    // return only the Cookie header required by the existing route assertions.
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.trim()); }
    catch { throw new Error("Owned contract mint returned invalid JSON"); }
    const cookies = parsed && typeof parsed === "object" && "cookies" in parsed ? parsed.cookies : undefined;
    if (!Array.isArray(cookies) || !cookies.length || cookies.some(cookie => !cookie || typeof cookie !== "object"
      || typeof cookie.name !== "string" || typeof cookie.value !== "string"
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || /[;\r\n]/.test(cookie.value))) {
      throw new Error("Owned contract mint returned invalid cookies");
    }
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  }

  return Object.freeze({ start, mint, close,
    resources: () => owner ? { directory: owner.directory,
      databaseName: decodeURIComponent(new URL(owner.env.DATABASE_URL!).pathname.slice(1)) } : undefined });
}
