import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaIssues } from "@megaui/database";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MegaBadRequestError, MegaConflictError, MegaForbiddenError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { SAMPLE_CL, USERS } from "../../testing/fixtures";
import { createIssuesService, type IssueTransitionAction } from "./index";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] issues/issues.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] issues/issues.test.ts: DATABASE_URL is unset — skipping PG issues suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Guarantees a distinct millisecond `createdAt`/`updatedAt` between sequential writes. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!adminDatabaseUrl)("createIssuesService list/state/comments/watch (EG-04, throwaway PG)", () => {
  const testDbName = `megaui_test_issues_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  it("creates an issue, seeds the author as watcher, and round-trips through getIssue", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      const created = await issues.createIssue(
        { title: "  New pack regression  ", packageId: "git-internal", priority: "P1", body: "Repro steps" },
        USERS.tianjing.id,
      );
      expect(created.title).toBe("New pack regression");
      expect(created.state).toBe("open");
      expect(created.priority).toBe("P1");
      expect(created.author.id).toBe(USERS.tianjing.id);
      expect(created.watcherIds).toEqual([USERS.tianjing.id]);
      expect(created.body).toBe("Repro steps");
      expect(created.commentCount).toBe(0);

      const fetched = await issues.getIssue(created.number);
      expect(fetched).toEqual(created);
      await client.db.update(megaIssues).set({ linkedCLs: [SAMPLE_CL.number, 99999] }).where(eq(megaIssues.id, created.id));
      expect((await issues.getIssue(created.number)).linkedClPublicIds).toEqual([SAMPLE_CL.publicId]);
    } finally {
      await client.close();
    }
  });

  it("rejects createIssue for an unauthenticated actor and a non-member actor", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const issues = createIssuesService(client.db);
      await expect(
        issues.createIssue({ title: "Anon issue", packageId: "git-internal", priority: "P2" }, null),
      ).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(
        issues.createIssue({ title: "Ghost issue", packageId: "git-internal", priority: "P2" }, "usr_does_not_exist"),
      ).rejects.toBeInstanceOf(MegaForbiddenError);
      await expect(
        issues.createIssue({ title: "  ", packageId: "git-internal", priority: "P2" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(
        issues.createIssue({ title: "Bad priority", packageId: "git-internal", priority: "P9" as never }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
    } finally {
      await client.close();
    }
  });

  describe("AC1: list filter/sort/pagination", () => {
    it("filters, sorts, and paginates, including empty state and out-of-range page", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);

        // Created sequentially (not Promise.all) so createdAt strictly increases
        // in this order — created-asc/created-desc assertions below depend on it.
        const issueA0 = await issues.createIssue({ title: "List pkg-a P0", packageId: "list-pkg-a", priority: "P0" }, USERS.tianjing.id);
        await sleep(5);
        const issueA2 = await issues.createIssue({ title: "List pkg-a P2", packageId: "list-pkg-a", priority: "P2" }, USERS.eleanor.id);
        await sleep(5);
        const issueB1 = await issues.createIssue({ title: "List pkg-b P1", packageId: "list-pkg-b", priority: "P1" }, USERS.rafael.id);
        await sleep(5);
        const issueB4 = await issues.createIssue({ title: "List pkg-b P4 findme", packageId: "list-pkg-b", priority: "P4" }, USERS.tianjing.id);

        // Close one issue so state filtering has signal.
        await issues.transitionIssueState(issueB4.number, "close", USERS.tianjing.id);

        // packageIds filter narrows to the matching package.
        const pkgA = await issues.listIssues({ filter: { packageIds: ["list-pkg-a"] } });
        expect(pkgA.items.map((issue) => issue.id).sort()).toEqual([issueA0.id, issueA2.id].sort());

        // states filter.
        const openOnly = await issues.listIssues({ filter: { packageIds: ["list-pkg-a", "list-pkg-b"], states: ["open"] } });
        expect(openOnly.items.map((issue) => issue.id).sort()).toEqual([issueA0.id, issueA2.id, issueB1.id].sort());
        const closedOnly = await issues.listIssues({ filter: { packageIds: ["list-pkg-a", "list-pkg-b"], states: ["closed"] } });
        expect(closedOnly.items.map((issue) => issue.id)).toEqual([issueB4.id]);

        // author filter (@me sentinel).
        const byMe = await issues.listIssues(
          { filter: { packageIds: ["list-pkg-a", "list-pkg-b"], author: "@me" } },
          USERS.tianjing.id,
        );
        expect(byMe.items.map((issue) => issue.id).sort()).toEqual([issueA0.id, issueB4.id].sort());

        // text filter matches title.
        const byText = await issues.listIssues({ filter: { packageIds: ["list-pkg-b"], text: "findme" } });
        expect(byText.items.map((issue) => issue.id)).toEqual([issueB4.id]);

        // priority range filter.
        const midPriority = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"], priority: { min: "P1", max: "P2" } },
        });
        expect(midPriority.items.every((issue) => issue.priority === "P1" || issue.priority === "P2")).toBe(true);
        expect(midPriority.items.map((issue) => issue.id).sort()).toEqual([issueA2.id, issueB1.id].sort());

        // Empty-array packageIds is an explicit "match nothing" filter (GC-02 matchesIssueFilter parity).
        const emptyPkgFilter = await issues.listIssues({ filter: { packageIds: [] } });
        expect(emptyPkgFilter.items).toEqual([]);
        expect(emptyPkgFilter.total).toBe(0);

        // priority-desc sort: P0 first, ties broken by updatedAt desc.
        const priorityDescExplicit = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"], sort: "priority-desc" },
        });
        expect(priorityDescExplicit.items.map((issue) => issue.priority)).toEqual(["P0", "P1", "P2", "P4"]);

        const createdAsc = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"], sort: "created-asc" },
        });
        expect(createdAsc.items.map((issue) => issue.id)).toEqual([issueA0.id, issueA2.id, issueB1.id, issueB4.id]);

        const createdDesc = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"], sort: "created-desc" },
        });
        expect(createdDesc.items.map((issue) => issue.id)).toEqual([issueB4.id, issueB1.id, issueA2.id, issueA0.id]);

        // Pagination: total reflects the filtered set; slicing is stable across pages.
        const page1 = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"], sort: "created-asc" },
          pagination: { offset: 0, limit: 2 },
        });
        expect(page1.items.map((issue) => issue.id)).toEqual([issueA0.id, issueA2.id]);
        expect(page1.total).toBe(4);
        expect(page1.offset).toBe(0);
        expect(page1.limit).toBe(2);

        const page2 = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"], sort: "created-asc" },
          pagination: { offset: 2, limit: 2 },
        });
        expect(page2.items.map((issue) => issue.id)).toEqual([issueB1.id, issueB4.id]);

        // Out-of-range page: no error, empty items, total still reflects the real count.
        const outOfRange = await issues.listIssues({
          filter: { packageIds: ["list-pkg-a", "list-pkg-b"] },
          pagination: { offset: 1000, limit: 20 },
        });
        expect(outOfRange.items).toEqual([]);
        expect(outOfRange.total).toBe(4);

        // Empty state: a package with zero issues.
        const emptyState = await issues.listIssues({ filter: { packageIds: ["list-pkg-nonexistent"] } });
        expect(emptyState.items).toEqual([]);
        expect(emptyState.total).toBe(0);

        // Invalid pagination input fails closed via the shared parser.
        await expect(
          issues.listIssues({ filter: { packageIds: ["list-pkg-a"] }, pagination: { limit: -1 } }),
        ).rejects.toBeInstanceOf(MegaBadRequestError);
      } finally {
        await client.close();
      }
    });

    it("defaults to updated-desc sort and default pagination (limit 20, offset 0)", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);
        const first = await issues.createIssue({ title: "Default sort A", packageId: "default-sort-pkg", priority: "P2" }, USERS.tianjing.id);
        await sleep(5);
        const second = await issues.createIssue({ title: "Default sort B", packageId: "default-sort-pkg", priority: "P2" }, USERS.tianjing.id);
        await sleep(5);
        // Touch `second` last so its updatedAt is newest.
        await issues.toggleIssueWatch(second.number, USERS.eleanor.id);

        const result = await issues.listIssues({ filter: { packageIds: ["default-sort-pkg"] } });
        expect(result.offset).toBe(0);
        expect(result.limit).toBe(20);
        expect(result.items[0]?.id).toBe(second.id);
        expect(result.items[1]?.id).toBe(first.id);
      } finally {
        await client.close();
      }
    });
  });

  describe("AC2: full state-transition legality matrix", () => {
    const MATRIX: ReadonlyArray<{
      from: "open" | "closed";
      action: IssueTransitionAction;
      legal: boolean;
    }> = [
      { from: "open", action: "close", legal: true },
      { from: "open", action: "reopen", legal: false },
      { from: "closed", action: "close", legal: false },
      { from: "closed", action: "reopen", legal: true },
    ];

    it.each(MATRIX)("from=$from action=$action legal=$legal", async ({ from, action, legal }) => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);
        const created = await issues.createIssue(
          { title: `Matrix ${from} ${action}`, packageId: "matrix-pkg", priority: "P2" },
          USERS.tianjing.id,
        );
        if (from === "closed") {
          await issues.transitionIssueState(created.number, "close", USERS.tianjing.id);
        }

        if (legal) {
          const result = await issues.transitionIssueState(created.number, action, USERS.tianjing.id);
          expect(result.state).toBe(action === "close" ? "closed" : "open");
          if (action === "close") {
            expect(result.closedAt).toBeDefined();
          } else {
            expect(result.closedAt).toBeUndefined();
          }
        } else {
          await expect(issues.transitionIssueState(created.number, action, USERS.tianjing.id)).rejects.toBeInstanceOf(
            MegaConflictError,
          );
          // Rejected transition must not mutate state.
          const unchanged = await issues.getIssue(created.number);
          expect(unchanged.state).toBe(from);
        }
      } finally {
        await client.close();
      }
    });

    it("close/reopen convenience wrappers delegate to the same legality matrix", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);
        const created = await issues.createIssue({ title: "Wrapper matrix", packageId: "matrix-pkg", priority: "P2" }, USERS.tianjing.id);

        const closed = await issues.closeIssue(created.number, USERS.tianjing.id);
        expect(closed.state).toBe("closed");
        await expect(issues.closeIssue(created.number, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaConflictError);

        const reopened = await issues.reopenIssue(created.number, USERS.tianjing.id);
        expect(reopened.state).toBe("open");
        await expect(issues.reopenIssue(created.number, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaConflictError);
      } finally {
        await client.close();
      }
    });

    it("rejects transitions from unauthenticated and non-member actors, and 404s a missing issue", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);
        const created = await issues.createIssue({ title: "Auth matrix", packageId: "matrix-pkg", priority: "P2" }, USERS.tianjing.id);

        await expect(issues.transitionIssueState(created.number, "close", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          issues.transitionIssueState(created.number, "close", "usr_does_not_exist"),
        ).rejects.toBeInstanceOf(MegaForbiddenError);
        await expect(issues.transitionIssueState(999_999, "close", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });

  describe("AC3: comment permission (non-member denied) + watch semantics", () => {
    it("denies comments from unauthenticated and non-member actors, allows members", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);
        const created = await issues.createIssue({ title: "Comment permission issue", packageId: "comment-pkg", priority: "P2" }, USERS.tianjing.id);

        await expect(issues.addIssueComment(created.number, "hi", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          issues.addIssueComment(created.number, "hi", "usr_does_not_exist"),
        ).rejects.toBeInstanceOf(MegaForbiddenError);
        await expect(issues.addIssueComment(created.number, "   ", USERS.eleanor.id)).rejects.toBeInstanceOf(MegaBadRequestError);
        await expect(issues.addIssueComment(999_999, "hi", USERS.eleanor.id)).rejects.toBeInstanceOf(MegaNotFoundError);

        const comment = await issues.addIssueComment(created.number, "A member comment", USERS.eleanor.id);
        expect(comment.body).toBe("A member comment");
        expect(comment.author.id).toBe(USERS.eleanor.id);
        expect(comment.issueNumber).toBe(created.number);

        const comments = await issues.listIssueComments(created.number);
        expect(comments).toHaveLength(1);
        expect(comments[0]).toMatchObject({ id: comment.id, body: "A member comment" });

        const withCount = await issues.getIssue(created.number);
        expect(withCount.commentCount).toBe(1);

        // A second member comment keeps the derived commentCount accurate.
        await issues.addIssueComment(created.number, "Second comment", USERS.rafael.id);
        expect((await issues.getIssue(created.number)).commentCount).toBe(2);
        expect((await issues.listIssueComments(created.number)).map((c) => c.body)).toEqual([
          "A member comment",
          "Second comment",
        ]);
      } finally {
        await client.close();
      }
    });

    it("toggles watch membership, is idempotent-reversible, and denies non-members", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const issues = createIssuesService(client.db);
        const created = await issues.createIssue({ title: "Watch semantics issue", packageId: "watch-pkg", priority: "P2" }, USERS.tianjing.id);

        // Author watches by default (create seeds watcherIds = [author]).
        expect(created.watcherIds).toEqual([USERS.tianjing.id]);

        // A second member starts watching.
        const watched = await issues.toggleIssueWatch(created.number, USERS.eleanor.id);
        expect(watched.watcherIds).toEqual(expect.arrayContaining([USERS.tianjing.id, USERS.eleanor.id]));
        expect(watched.watcherIds).toHaveLength(2);

        // Toggling again removes them; toggling twice returns to the original set.
        const unwatched = await issues.toggleIssueWatch(created.number, USERS.eleanor.id);
        expect(unwatched.watcherIds).toEqual([USERS.tianjing.id]);

        // Persisted across reads.
        expect((await issues.getIssue(created.number)).watcherIds).toEqual([USERS.tianjing.id]);

        // The author can also unwatch their own issue.
        const authorUnwatched = await issues.toggleIssueWatch(created.number, USERS.tianjing.id);
        expect(authorUnwatched.watcherIds).toEqual([]);

        await expect(issues.toggleIssueWatch(created.number, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          issues.toggleIssueWatch(created.number, "usr_does_not_exist"),
        ).rejects.toBeInstanceOf(MegaForbiddenError);
        await expect(issues.toggleIssueWatch(999_999, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });
});
