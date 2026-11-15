// EG-01 AC3: seedMegaDatabase is idempotent on a throwaway Postgres.
//
// Requires DATABASE_URL pointing at a reachable Postgres with CREATEDB.
// The seed runs against a one-shot database, never against the DB named in
// DATABASE_URL itself. In CI (`CI=true`), missing DATABASE_URL is a hard
// failure. Locally the suite skips with a console warning.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "./seed";
import { SAMPLE_CHANNEL, SAMPLE_CL, SAMPLE_DOC, SAMPLE_MESSAGES } from "./testing/fixtures";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error(
      "[@megaui/engine] seed.test.ts: DATABASE_URL is required in CI (postgres service must be provisioned).",
    );
  }
  console.warn(
    "[@megaui/engine] seed.test.ts: DATABASE_URL is unset — skipping the seed idempotency suite.",
  );
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)(
  "seedMegaDatabase on a one-shot test DB (EG-01 AC3)",
  () => {
    const testDbName = `megaui_test_seed_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

    it("inserts fixture rows once and skips them on a second run", async () => {
      const migratePool = new Pool({ connectionString });
      const client = createDatabaseClient({ connectionString });
      try {
        await migrate(drizzle(migratePool), { migrationsFolder });
        const first = await seedMegaDatabase(client.db);
        expect(first.inserted).toBeGreaterThan(0);
        expect(first.skipped).toBe(0);

        const users = await migratePool.query(`select count(*)::int as n from "user"`);
        const docs = await migratePool.query(`select count(*)::int as n from mega_docs`);
        const cls = await migratePool.query(`select count(*)::int as n from mega_cls`);
        const channels = await migratePool.query(
          `select count(*)::int as n from mega_channels`,
        );
        const messages = await migratePool.query(
          `select count(*)::int as n from mega_messages`,
        );
        const stars = await migratePool.query(
          `select count(*)::int as n from mega_doc_stars`,
        );
        expect(users.rows[0]?.n).toBe(3);
        expect(docs.rows[0]?.n).toBe(1);
        expect(cls.rows[0]?.n).toBe(1);
        expect(channels.rows[0]?.n).toBe(1);
        expect(messages.rows[0]?.n).toBe(SAMPLE_MESSAGES.length);
        expect(stars.rows[0]?.n).toBe(1);

        const titled = await migratePool.query(
          `select title from mega_docs where id = $1`,
          [SAMPLE_DOC.id],
        );
        expect(titled.rows[0]?.title).toBe(SAMPLE_DOC.title);
        const cl = await migratePool.query(`select number from mega_cls where id = $1`, [
          SAMPLE_CL.id,
        ]);
        expect(cl.rows[0]?.number).toBe(SAMPLE_CL.number);
        const channel = await migratePool.query(
          `select name from mega_channels where id = $1`,
          [SAMPLE_CHANNEL.id],
        );
        expect(channel.rows[0]?.name).toBe(SAMPLE_CHANNEL.name);

        const second = await seedMegaDatabase(client.db);
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBeGreaterThan(0);
        expect(second.inserted + second.skipped).toBe(first.inserted + first.skipped);

        const usersAfter = await migratePool.query(`select count(*)::int as n from "user"`);
        expect(usersAfter.rows[0]?.n).toBe(3);
      } finally {
        await client.close();
        await migratePool.end();
      }
    });
  },
);
