/**
 * Local PG auth smoke (PK-06 AC1) — not part of the CI gate.
 *
 * Usage:
 *   DATABASE_URL=postgres://megaui:megaui@localhost:5432/website \
 *     pnpm --filter @megaui/auth smoke:login
 *
 * Creates a throwaway database, applies migrations, then exercises
 * sign-up → sign-in → getSession → sign-out → getSession via better-auth's
 * server API. Prints a sanitized JSON summary (no passwords / secrets).
 *
 * Skipped automatically when `DATABASE_URL` is unset (CI does not set
 * `SMOKE_AUTH=1`; the package script always sets it).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "@megaui/database";
import { createEmailSender, createTestEmailProvider } from "@megaui/email";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/create-auth";

const adminDatabaseUrl = process.env.DATABASE_URL;
const runSmoke = process.env.SMOKE_AUTH === "1" && Boolean(adminDatabaseUrl);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../database/drizzle");

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function sanitizeEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "<redacted>";
  return `${local.slice(0, 2)}***@${domain}`;
}

describe.skipIf(!runSmoke)("PK-06 local PG auth smoke (manual)", () => {
  const testDbName = `megaui_auth_smoke_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: Pool;
  let connectionString: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
  });

  afterAll(async () => {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  });

  it("sign-up / sign-in / session / sign-out against a throwaway PG", async () => {
    const client = createDatabaseClient({ connectionString });
    const migratePool = new Pool({ connectionString });
    const summary: Record<string, unknown> = {
      ok: false,
      database: testDbName,
      steps: [] as string[],
    };

    try {
      await migrate(drizzle(migratePool), { migrationsFolder });
      (summary.steps as string[]).push("migrate");

      const testProvider = createTestEmailProvider();
      const email = createEmailSender({
        defaultFrom: "noreply@example.com",
        provider: { kind: "test", provider: testProvider },
      });

      const auth = createAuth({
        appName: "megaui-smoke",
        secret: "smoke-test-secret-at-least-32-chars!!",
        baseURL: "http://localhost:3000",
        db: client.db,
        email,
        requireEmailVerification: false,
        socialProviders: {},
        trustedOrigins: {
          appBaseUrl: "http://localhost:3000",
          trustedOriginsCsv: "http://127.0.0.1:17001",
        },
        nodeEnv: "test",
      });

      const emailAddress = `smoke.${randomUUID().slice(0, 8)}@example.com`;
      const password = `Pw-${randomUUID()}`;

      const signedUp = await auth.api.signUpEmail({
        body: {
          email: emailAddress,
          password,
          name: "Smoke User",
        },
      });
      (summary.steps as string[]).push("signUpEmail");
      summary.userId = signedUp.user.id;
      summary.email = sanitizeEmail(signedUp.user.email);

      const signedIn = await auth.api.signInEmail({
        body: {
          email: emailAddress,
          password,
        },
        returnHeaders: true,
      });
      (summary.steps as string[]).push("signInEmail");

      const setCookie = signedIn.headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      const headers = new Headers();
      headers.set("cookie", setCookie!.split(",")[0]!.split(";")[0]!);

      const session = await auth.api.getSession({ headers });
      expect(session?.user?.id).toBe(signedUp.user.id);
      (summary.steps as string[]).push("getSession");
      summary.sessionUserId = session!.user.id;

      await auth.api.signOut({ headers });
      (summary.steps as string[]).push("signOut");

      const afterSignOut = await auth.api.getSession({ headers });
      expect(afterSignOut?.user).toBeFalsy();
      (summary.steps as string[]).push("getSession-empty");

      summary.ok = true;
      summary.capturedEmails = testProvider.getAll().map((mail) => ({
        to: sanitizeEmail(String(mail.to)),
        subject: mail.subject,
      }));

      // Sanitized evidence for the plan card (no passwords / secrets).
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      await client.close();
      await migratePool.end();
    }
  });
});
