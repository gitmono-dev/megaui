import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaContent, megaContentContainerTypes, megaIssues } from "@megaui/database";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MegaBadRequestError, MegaForbiddenError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { createIssuesService } from "./index";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] issues/issues-body.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] issues/issues-body.test.ts: DATABASE_URL is unset — skipping PG issue body suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!adminDatabaseUrl)("createIssuesService get/save issue body (IB-01, throwaway PG)", () => {
  const testDbName = `megaui_test_issues_body_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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
  }, 120_000);

  afterAll(async () => {
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    await adminPool.end();
  }, 60_000);

  it("returns empty body when the issue has no content row (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "No description", packageId: "body-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      expect(created.body).toBeUndefined();
      expect(await issues.getIssueBody(created.number)).toEqual({ body: "" });
    } finally {
      await client.close();
    }
  });

  it("upserts mega_content { text } and bumps updatedAt in one transaction (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Body persist", packageId: "body-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      const before = created.updatedAt;
      await sleep(5);
      const saved = await issues.saveIssueBody(created.number, "  Persisted body  ", USERS.tianjing.id);
      expect(saved).toEqual({ body: "Persisted body" });

      const [content] = await client.db
        .select({ bodyJson: megaContent.bodyJson, bodyFormatVersion: megaContent.bodyFormatVersion })
        .from(megaContent)
        .where(
          and(
            eq(megaContent.containerType, megaContentContainerTypes.ISSUE),
            eq(megaContent.containerId, created.id),
          ),
        )
        .limit(1);
      expect(content?.bodyJson).toEqual({ text: "Persisted body" });
      expect(content?.bodyFormatVersion).toBe(1);

      const fetched = await issues.getIssue(created.number);
      expect(fetched.updatedAt > before).toBe(true);

      await client.db
        .update(megaContent)
        .set({ bodyFormatVersion: 2 })
        .where(
          and(
            eq(megaContent.containerType, megaContentContainerTypes.ISSUE),
            eq(megaContent.containerId, created.id),
          ),
        );
      await issues.saveIssueBody(created.number, "Conflict update", USERS.tianjing.id);
      const [rewritten] = await client.db
        .select({ bodyJson: megaContent.bodyJson, bodyFormatVersion: megaContent.bodyFormatVersion })
        .from(megaContent)
        .where(
          and(
            eq(megaContent.containerType, megaContentContainerTypes.ISSUE),
            eq(megaContent.containerId, created.id),
          ),
        )
        .limit(1);
      expect(rewritten?.bodyJson).toEqual({ text: "Conflict update" });
      expect(rewritten?.bodyFormatVersion).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("projects saved text onto getIssue.body (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Body projection", packageId: "body-pkg", priority: "P2", body: "Initial" },
        USERS.tianjing.id,
      );
      expect((await issues.getIssueBody(created.number)).body).toBe("Initial");
      await issues.saveIssueBody(created.number, "Updated description", USERS.tianjing.id);
      expect((await issues.getIssue(created.number)).body).toBe("Updated description");
      expect(await issues.getIssueBody(created.number)).toEqual({ body: "Updated description" });
    } finally {
      await client.close();
    }
  });

  it("rejects empty or whitespace bodies (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Empty body reject", packageId: "body-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      await expect(issues.saveIssueBody(created.number, "", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
      await expect(issues.saveIssueBody(created.number, "   ", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
    } finally {
      await client.close();
    }
  });

  it("gates save behind membership then author-or-assignee (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Body authz", packageId: "body-pkg", priority: "P2" },
        USERS.tianjing.id,
      );

      await expect(issues.saveIssueBody(created.number, "nope", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(issues.saveIssueBody(created.number, "nope", "usr_does_not_exist")).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );
      await expect(issues.saveIssueBody(created.number, "nope", USERS.eleanor.id)).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );
      await expect(issues.saveIssueBody(999_999, "nope", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
      await expect(issues.getIssueBody(999_999)).rejects.toBeInstanceOf(MegaNotFoundError);

      await client.db
        .update(megaIssues)
        .set({ assigneeIds: [USERS.eleanor.id] })
        .where(eq(megaIssues.number, created.number));

      const asAssignee = await issues.saveIssueBody(created.number, "Assignee may edit", USERS.eleanor.id);
      expect(asAssignee).toEqual({ body: "Assignee may edit" });
      expect((await issues.getIssue(created.number)).body).toBe("Assignee may edit");

      await expect(issues.saveIssueBody(created.number, "watcher cannot", USERS.rafael.id)).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );
    } finally {
      await client.close();
    }
  });
});
