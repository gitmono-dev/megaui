import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaIssues } from "@megaui/database";
import { eq } from "drizzle-orm";
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
    throw new Error("[@megaui/engine] issues/issues-reactions.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] issues/issues-reactions.test.ts: DATABASE_URL is unset — skipping PG issue reactions suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!adminDatabaseUrl)("createIssuesService issue/comment reactions (RX-01, throwaway PG)", () => {
  const testDbName = `megaui_test_issues_rx_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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
  }, 120_000);

  it("persists issue ReactionRows, projects for the actor, and does not clobber another actor (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Issue reaction persist", packageId: "rx-pkg", priority: "P2" },
        USERS.tianjing.id,
      );

      const added = await issues.toggleIssueReaction(created.number, "👍", USERS.tianjing.id);
      expect(added.reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

      const [stored] = await client.db
        .select({ reactions: megaIssues.reactions })
        .from(megaIssues)
        .where(eq(megaIssues.number, created.number))
        .limit(1);
      expect(stored?.reactions).toEqual([{ emoji: "👍", userIds: [USERS.tianjing.id] }]);

      const second = await issues.toggleIssueReaction(created.number, "👍", USERS.eleanor.id);
      expect(second.reactions).toEqual([{ emoji: "👍", count: 2, reactedByMe: true }]);
      expect(await issues.getIssue(created.number, USERS.tianjing.id)).toMatchObject({
        reactions: [{ emoji: "👍", count: 2, reactedByMe: true }],
      });

      const removed = await issues.toggleIssueReaction(created.number, "👍", USERS.tianjing.id);
      expect(removed.reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: false }]);
      expect((await issues.getIssue(created.number, USERS.eleanor.id)).reactions).toEqual([
        { emoji: "👍", count: 1, reactedByMe: true },
      ]);
    } finally {
      await client.close();
    }
  });

  it("toggles comment reactions without bumping issue updatedAt (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Comment reaction persist", packageId: "rx-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      const comment = await issues.addIssueComment(created.number, "Needs a reaction", USERS.tianjing.id);
      const before = (await issues.getIssue(created.number)).updatedAt;
      await sleep(5);

      const added = await issues.toggleIssueCommentReaction(comment.id, "🎉", USERS.eleanor.id);
      expect(added.reactions).toEqual([{ emoji: "🎉", count: 1, reactedByMe: true }]);
      expect((await issues.listIssueComments(created.number, USERS.eleanor.id))[0]?.reactions).toEqual([
        { emoji: "🎉", count: 1, reactedByMe: true },
      ]);
      expect((await issues.getIssue(created.number)).updatedAt).toBe(before);

      const removed = await issues.toggleIssueCommentReaction(comment.id, "🎉", USERS.eleanor.id);
      expect(removed.reactions).toEqual([]);

      await expect(issues.toggleIssueCommentReaction("ic_missing", "🎉", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaNotFoundError,
      );
    } finally {
      await client.close();
    }
  });

  it("projects the same reactions from listIssues and getIssue for one actor (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Projection parity", packageId: "rx-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      await issues.toggleIssueReaction(created.number, "🚀", USERS.tianjing.id);
      await issues.toggleIssueReaction(created.number, "🚀", USERS.eleanor.id);

      const listed = await issues.listIssues({}, USERS.eleanor.id);
      const match = listed.items.find((issue) => issue.number === created.number);
      const detail = await issues.getIssue(created.number, USERS.eleanor.id);
      expect(match?.reactions).toEqual(detail.reactions);
      expect(detail.reactions).toEqual([{ emoji: "🚀", count: 2, reactedByMe: true }]);
      expect((await issues.getIssue(created.number, USERS.rafael.id)).reactions).toEqual([
        { emoji: "🚀", count: 2, reactedByMe: false },
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects empty or whitespace emoji (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Empty emoji reject", packageId: "rx-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      const comment = await issues.addIssueComment(created.number, "blank emoji", USERS.tianjing.id);

      await expect(issues.toggleIssueReaction(created.number, "", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
      await expect(issues.toggleIssueReaction(created.number, "   ", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
      await expect(issues.toggleIssueCommentReaction(comment.id, "", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
    } finally {
      await client.close();
    }
  });

  it("gates toggle behind membership (new)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "Reaction authz", packageId: "rx-pkg", priority: "P2" },
        USERS.tianjing.id,
      );
      const comment = await issues.addIssueComment(created.number, "authz comment", USERS.tianjing.id);

      await expect(issues.toggleIssueReaction(created.number, "👍", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(issues.toggleIssueReaction(created.number, "👍", "usr_does_not_exist")).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );
      await expect(issues.toggleIssueReaction(999_999, "👍", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
      await expect(issues.toggleIssueCommentReaction(comment.id, "👍", null)).rejects.toBeInstanceOf(
        MegaUnauthorizedError,
      );
      await expect(issues.toggleIssueCommentReaction(comment.id, "👍", "usr_does_not_exist")).rejects.toBeInstanceOf(
        MegaForbiddenError,
      );

      const asOtherMember = await issues.toggleIssueReaction(created.number, "❤️", USERS.rafael.id);
      expect(asOtherMember.reactions).toEqual([{ emoji: "❤️", count: 1, reactedByMe: true }]);
    } finally {
      await client.close();
    }
  });
});
