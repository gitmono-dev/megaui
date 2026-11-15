// megaui-only (FS-40): one real Web/PG pair per harness run.
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { randomBytes } from "node:crypto";
import { IsolatedServer } from "./isolated-server";

export type WebHarnessMode = "enterprise" | "legacy";

export interface EnterpriseWebFixture {
  readonly mode: WebHarnessMode;
  readonly origin: string;
  readonly server: IsolatedServer;
  readonly database: IsolatedPostgres;
  readonly admin: DatabaseClient;
  restart(): Promise<void>;
  close(): Promise<void>;
}

function webDatabaseUrl(database: IsolatedPostgres, role: string, password: string): string {
  const url = new URL(database.databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function configureWebDatabase(database: IsolatedPostgres, admin: DatabaseClient, mode: WebHarnessMode): Promise<string> {
  const role = `fs40_${mode}_${database.runId}`;
  const password = randomBytes(24).toString("hex");
  const name = decodeURIComponent(new URL(database.databaseUrl).pathname.slice(1)).replaceAll('"', '""');
  await admin.pool.query(`create role "${role}" login password '${password}';
    revoke create on schema public from public;
    revoke create on database "${name}" from public;
    grant connect on database "${name}" to "${role}";
    grant usage on schema public to "${role}";
    grant select,insert,update,delete on all tables in schema public to "${role}";
    grant usage,select on all sequences in schema public to "${role}"`);
  if (mode === "enterprise") {
    await admin.pool.query(`insert into enterprise_policy
      (id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ($1,$2,'fs40-owner','test','test','enterprise',1)`, [`policy-${database.runId}`, database.runId]);
  }
  return webDatabaseUrl(database, role, password);
}

export async function createEnterpriseWebFixture(mode: WebHarnessMode): Promise<EnterpriseWebFixture> {
  const database = await createIsolatedPostgres();
  let admin: DatabaseClient | undefined;
  let server: IsolatedServer | undefined;
  try {
    await database.migrate();
    admin = createDatabaseClient({ connectionString: database.databaseUrl, connectionTimeoutMillis: 1_000, statementTimeoutMillis: 3_000 });
    const scopedUrl = await configureWebDatabase(database, admin, mode);
    const origin = "http://127.0.0.1:0";
    const explicit: Record<string, string> = {
      AUTH_MODE: mode,
      DATABASE_URL: scopedUrl,
      MEGAUI_APP_NAME: "megaui-fs40",
      BETTER_AUTH_SECRET: "synthetic-fs40-auth-secret-at-least-32-bytes",
      EMAIL_PROVIDER: "test",
      EMAIL_DEFAULT_FROM: "owned@example.test",
      APP_BASE_URL: origin,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_TRUSTED_ORIGINS: origin,
    };
    if (mode === "enterprise") Object.assign(explicit, {
      ENTERPRISE_PROCESS_ROLE: "web",
      ENTERPRISE_OWNER_FINGERPRINT: "fs40-owner",
      ENTERPRISE_DB_INSTANCE_ID: database.runId,
      ENTERPRISE_DEPLOYMENT_ROLE: "test",
      FEISHU_TENANT_KEY: "fs40-tenant",
      FEISHU_APP_ID: "fs40-app",
      ENTERPRISE_IP_HMAC_MASTER_KEY: Buffer.alloc(32, 40).toString("base64url"),
      ENTERPRISE_TRUSTED_PROXY_CIDRS: "[]",
    });
    server = await IsolatedServer.create({ env: explicit, readyPath: "/api/health" });
    // The final origin/port is fixed before startup. Only the explicit origin
    // values change; no ambient env is ever copied into the child.
    explicit.APP_BASE_URL = server.origin;
    explicit.BETTER_AUTH_URL = server.origin;
    explicit.BETTER_AUTH_TRUSTED_ORIGINS = server.origin;
    for (const [key, value] of Object.entries(explicit)) server.env[key] = value;
    await server.start();
    const owned = server;
    const ownedAdmin = admin;
    return {
      mode, origin: server.origin, server: owned, database, admin: ownedAdmin,
      restart: () => owned.restart(),
      close: async () => {
        const failures: unknown[] = [];
        try { await owned.close(); } catch (error) { failures.push(error); }
        try { await ownedAdmin.close(); } catch (error) { failures.push(error); }
        try { await database.destroy(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "FS40 Web fixture cleanup failed");
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    try { await server?.close(); } catch (failure) { failures.push(failure); }
    try { await admin?.close(); } catch (failure) { failures.push(failure); }
    try { await database.destroy(); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], "FS40 Web fixture setup/cleanup failed", { cause: error });
    throw error;
  }
}

export async function withEnterpriseWebFixture<T>(mode: WebHarnessMode, work: (fixture: EnterpriseWebFixture) => Promise<T>): Promise<T> {
  const fixture = await createEnterpriseWebFixture(mode);
  try {
    const result = await work(fixture);
    await fixture.close();
    return result;
  } catch (error) {
    try { await fixture.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "FS40 Web fixture test/cleanup failed", { cause: cleanup }); }
    throw error;
  }
}

