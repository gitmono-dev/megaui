import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MegaBadRequestError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { CODE_README_MAX_LENGTH, createSiteSettingsService } from "./index";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] site-settings/site-settings.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] site-settings/site-settings.test.ts: DATABASE_URL is unset — skipping PG site-settings suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("createSiteSettingsService code README (throwaway PG)", () => {
  const testDbName = `megaui_test_site_settings_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: import("pg").Pool;
  let connectionString: string;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
    const migratePool = new Pool({ connectionString });
    const client = createDatabaseClient({ connectionString });
    try {
      await migrate((await import("drizzle-orm/node-postgres")).drizzle(migratePool), { migrationsFolder });
      await seedMegaDatabase(client.db);
    } finally {
      await client.close();
      await migratePool.end();
    }
  });

  afterAll(async () => {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  });

  it("returns an empty README before any write", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const service = createSiteSettingsService(client.db);
      expect(await service.getCodeReadme()).toEqual({ markdown: "", updatedAt: null, updatedBy: null });
    } finally {
      await client.close();
    }
  });

  it("stores, overwrites and clears the README with the writer recorded", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const service = createSiteSettingsService(client.db);

      const first = await service.setCodeReadme({ markdown: "# Hello\n\nfirst", actorUserId: USERS.tianjing.id });
      expect(first.markdown).toBe("# Hello\n\nfirst");
      expect(first.updatedBy).toBe(USERS.tianjing.id);
      expect(first.updatedAt).not.toBeNull();

      const second = await service.setCodeReadme({ markdown: "# Hello\n\nsecond", actorUserId: USERS.eleanor.id });
      expect(second.markdown).toBe("# Hello\n\nsecond");
      expect(second.updatedBy).toBe(USERS.eleanor.id);
      expect(await service.getCodeReadme()).toEqual(second);

      const cleared = await service.setCodeReadme({ markdown: "  \n\t", actorUserId: USERS.eleanor.id });
      expect(cleared).toEqual({ markdown: "", updatedAt: null, updatedBy: null });
      expect(await service.getCodeReadme()).toEqual(cleared);
    } finally {
      await client.close();
    }
  });

  it("rejects oversize input and a missing actor without writing", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const service = createSiteSettingsService(client.db);
      await service.setCodeReadme({ markdown: "keep me", actorUserId: USERS.tianjing.id });

      await expect(
        service.setCodeReadme({ markdown: "x".repeat(CODE_README_MAX_LENGTH + 1), actorUserId: USERS.tianjing.id }),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(
        service.setCodeReadme({ markdown: "other", actorUserId: "  " }),
      ).rejects.toBeInstanceOf(MegaUnauthorizedError);

      expect((await service.getCodeReadme()).markdown).toBe("keep me");
    } finally {
      await client.close();
    }
  });
});
