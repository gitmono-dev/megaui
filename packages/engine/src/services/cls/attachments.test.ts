// megaui:libs/mega/services/cls.ts@0ff3a9d
// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d
//
// EG-06 attachments (checks/deps/revisions/inline) — throwaway-PG suite
// mirroring cls.test.ts's harness (own database per run, migrated + seeded
// once, closed per-test client). Covers all three EG-06 acceptance
// criteria:
//   AC1 "checks CRUD 与状态聚合单测"          -> "checks CRUD + status aggregation" below
//   AC2 "inline comment 锚点校验（越界行号/失效 revision 拒绝）" -> "inline comment anchor validation" below
//   AC3 "dep-graph 数据闭环（环检测输入给前端布局）"  -> "dependency graph + cycle detection" below
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaCls } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MegaBadRequestError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { aggregateCheckStatus } from "./checks";
import { createClsService } from "./cls";
import { detectDependencyCycles } from "./deps";

describe("aggregateCheckStatus (pure, no PG — EG-06 AC1 status aggregation)", () => {
  it("defaults to queued for an empty check list", () => {
    expect(aggregateCheckStatus([])).toBe("queued");
  });

  it("prioritizes failing > running > queued > (all-skipped ? skipped : passing)", () => {
    const check = (status: string) => ({ id: "c", name: "n", status: status as never });
    expect(aggregateCheckStatus([check("passing"), check("failing")])).toBe("failing");
    expect(aggregateCheckStatus([check("passing"), check("running")])).toBe("running");
    expect(aggregateCheckStatus([check("passing"), check("queued")])).toBe("queued");
    expect(aggregateCheckStatus([check("skipped"), check("skipped")])).toBe("skipped");
    expect(aggregateCheckStatus([check("passing"), check("skipped")])).toBe("passing");
    expect(aggregateCheckStatus([check("passing")])).toBe("passing");
  });
});

describe("detectDependencyCycles (pure, no PG — EG-06 AC3 cycle-detection input)", () => {
  it("returns no cycles for an acyclic graph", () => {
    const nodes = [{ id: "a", label: "a", kind: "this" as const }, { id: "b", label: "b", kind: "downstream" as const }];
    const edges = [{ id: "e1", from: "a", to: "b", heat: "low" as const }];
    expect(detectDependencyCycles(nodes, edges)).toEqual([]);
  });

  it("detects a simple cycle across three nodes", () => {
    const nodes = ["a", "b", "c"].map((id) => ({ id, label: id, kind: "this" as const }));
    const edges = [
      { id: "e1", from: "a", to: "b", heat: "low" as const },
      { id: "e2", from: "b", to: "c", heat: "low" as const },
      { id: "e3", from: "c", to: "a", heat: "low" as const },
    ];
    const cycles = detectDependencyCycles(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b", "c"]));
  });

  it("reports a self-loop as a length-1 cycle and dedupes cycles found from either direction", () => {
    const nodes = ["a", "b"].map((id) => ({ id, label: id, kind: "this" as const }));
    const edges = [
      { id: "e1", from: "a", to: "a", heat: "low" as const },
      { id: "e2", from: "a", to: "b", heat: "low" as const },
      { id: "e3", from: "b", to: "a", heat: "low" as const },
    ];
    const cycles = detectDependencyCycles(nodes, edges);
    expect(cycles.some((cycle) => cycle.length === 1 && cycle[0] === "a")).toBe(true);
    expect(cycles.filter((cycle) => cycle.length === 2)).toHaveLength(1);
  });

  it("finds both cycles in a diamond graph that share a node (EG-05 P1: a global visited set must not drop a sibling cycle)", () => {
    // a -> b -> d -> a  and  a -> c -> d -> a: two distinct simple cycles
    // sharing nodes `a` and `d`. A DFS that marks `d` visited while walking
    // the first cycle must still explore it again via `c` to find the second.
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, label: id, kind: "this" as const }));
    const edges = [
      { id: "e1", from: "a", to: "b", heat: "low" as const },
      { id: "e2", from: "a", to: "c", heat: "low" as const },
      { id: "e3", from: "b", to: "d", heat: "low" as const },
      { id: "e4", from: "c", to: "d", heat: "low" as const },
      { id: "e5", from: "d", to: "a", heat: "low" as const },
    ];
    const cycles = detectDependencyCycles(nodes, edges);
    const cycleSets = cycles.map((cycle) => new Set(cycle));
    expect(cycleSets).toHaveLength(2);
    expect(cycleSets).toContainEqual(new Set(["a", "b", "d"]));
    expect(cycleSets).toContainEqual(new Set(["a", "c", "d"]));
  });
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] cls/attachments.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] cls/attachments.test.ts: DATABASE_URL is unset — skipping PG CL attachments suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("CL attachments: checks/deps/revisions/inline (EG-06, throwaway PG)", () => {
  const testDbName = `megaui_test_cls_attach_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  describe("checks CRUD + status aggregation (AC1)", () => {
    it("getCLChecks defaults to an empty view; upsert creates/updates in place and aggregates mega_cls.ci; delete removes a run", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const cls = createClsService(client.db);
        const created = await cls.createCL({ title: "Checks probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);

        const empty = await cls.getCLChecks(created.number);
        expect(empty).toEqual({ pipeline: [], runner: "", checks: [], logTail: [], benchmarks: [] });

        await expect(
          cls.upsertCLCheckRun(created.number, { name: "lint", status: "queued" }, null),
        ).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          cls.upsertCLCheckRun(created.number, { name: "  ", status: "queued" }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        const afterCreate = await cls.upsertCLCheckRun(
          created.number,
          { name: "lint", status: "running" },
          USERS.tianjing.id,
        );
        expect(afterCreate.checks).toHaveLength(1);
        const checkId = afterCreate.checks[0]!.id;
        expect(afterCreate.checks[0]).toMatchObject({ name: "lint", status: "running" });

        const afterMidRun = await cls.getCL(created.number);
        expect(afterMidRun.ci).toBe("running");

        const secondCheck = await cls.upsertCLCheckRun(
          created.number,
          { name: "unit", status: "failing" },
          USERS.tianjing.id,
        );
        expect(secondCheck.checks).toHaveLength(2);
        const afterFailing = await cls.getCL(created.number);
        expect(afterFailing.ci).toBe("failing");

        const updated = await cls.upsertCLCheckRun(
          created.number,
          { id: checkId, name: "lint", status: "passing" },
          USERS.tianjing.id,
        );
        expect(updated.checks).toHaveLength(2);
        expect(updated.checks.find((check) => check.id === checkId)).toMatchObject({ status: "passing" });

        const afterDelete = await cls.deleteCLCheckRun(created.number, checkId, USERS.tianjing.id);
        expect(afterDelete.checks).toHaveLength(1);
        expect(afterDelete.checks.some((check) => check.id === checkId)).toBe(false);
        const afterDeleteCL = await cls.getCL(created.number);
        expect(afterDeleteCL.ci).toBe("failing");

        await expect(
          cls.deleteCLCheckRun(created.number, "check_missing", USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
        await expect(cls.getCLChecks(999_999)).rejects.toBeInstanceOf(MegaNotFoundError);
        await expect(
          cls.upsertCLCheckRun(999_999, { name: "lint", status: "queued" }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });

  describe("dependency graph + cycle detection (AC3)", () => {
    it("getCLDependencyGraph defaults empty; setCLDependencyGraph round-trips and surfaces detected cycles", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const cls = createClsService(client.db);
        const created = await cls.createCL({ title: "Deps probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);

        const empty = await cls.getCLDependencyGraph(created.number);
        expect(empty).toEqual({ nodes: [], edges: [], apiChanges: [], relatedCLs: [], symbolUsage: [], cycles: [] });

        await expect(
          cls.setCLDependencyGraph(created.number, { nodes: [], edges: [] }, null),
        ).rejects.toBeInstanceOf(MegaUnauthorizedError);

        const acyclic = await cls.setCLDependencyGraph(
          created.number,
          {
            nodes: [
              { id: "common", label: "common", kind: "upstream" },
              { id: "self", label: "self", kind: "this" },
            ],
            edges: [{ id: "e1", from: "self", to: "common", heat: "medium" }],
            relatedCLs: [{ id: "related", number: created.number, relation: "follows" }],
          },
          USERS.tianjing.id,
        );
        expect(acyclic.cycles).toEqual([]);
        expect(acyclic.relatedCLs[0]?.publicId).toBe(created.publicId);
        expect((await cls.getCLDependencyGraph(created.number)).relatedCLs[0]?.publicId).toBe(created.publicId);

        const cyclic = await cls.setCLDependencyGraph(
          created.number,
          {
            nodes: [
              { id: "a", label: "a", kind: "this" },
              { id: "b", label: "b", kind: "downstream" },
            ],
            edges: [
              { id: "e1", from: "a", to: "b", heat: "high" },
              { id: "e2", from: "b", to: "a", heat: "high" },
            ],
          },
          USERS.tianjing.id,
        );
        expect(cyclic.cycles).toHaveLength(1);
        expect(new Set(cyclic.cycles[0])).toEqual(new Set(["a", "b"]));

        const reloaded = await cls.getCLDependencyGraph(created.number);
        expect(reloaded.edges).toHaveLength(2);
        expect(reloaded.cycles).toHaveLength(1);

        await expect(
          cls.setCLDependencyGraph(999_999, { nodes: [], edges: [] }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });

  describe("revisions (createCLRevision/listCLRevisions — supports AC2's revision anchor)", () => {
    it("creates newest-first, numbered revisions, fails closed on a blank sha/anonymous actor, and surfaces on CL.revisions", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const cls = createClsService(client.db);
        const created = await cls.createCL({ title: "Revisions probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);

        expect(await cls.listCLRevisions(created.number)).toEqual([]);
        await expect(cls.createCLRevision(created.number, { sha: "abc123" }, null)).rejects.toBeInstanceOf(
          MegaUnauthorizedError,
        );
        await expect(
          cls.createCLRevision(created.number, { sha: "  " }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        const rev1 = await cls.createCLRevision(created.number, { sha: "abc123" }, USERS.tianjing.id);
        expect(rev1.number).toBe(1);
        const rev2 = await cls.createCLRevision(created.number, { sha: "def456", summary: "rebase" }, USERS.tianjing.id);
        expect(rev2.number).toBe(2);

        const revisions = await cls.listCLRevisions(created.number);
        expect(revisions.map((revision) => revision.number)).toEqual([2, 1]);

        const reloaded = await cls.getCL(created.number);
        expect(reloaded.revisions.map((revision) => revision.number)).toEqual([2, 1]);

        await expect(cls.createCLRevision(999_999, { sha: "x" }, USERS.tianjing.id)).rejects.toBeInstanceOf(
          MegaNotFoundError,
        );
      } finally {
        await client.close();
      }
    });
  });

  describe("inline comment anchor validation (AC2)", () => {
    async function seedClWithFile(cls: ReturnType<typeof createClsService>, client: { db: unknown }, patchLineCount: number) {
      const created = await cls.createCL({ title: "Inline probe", packageId: "pkg_engine", branch: "b" }, USERS.tianjing.id);
      const patch = Array.from({ length: patchLineCount }, (_, index) => `+line ${index + 1}`).join("\n");
      const db = client.db as import("@megaui/database").Database;
      await db
        .update(megaCls)
        .set({
          files: [
            {
              path: "src/app.ts",
              status: "modified",
              additions: patchLineCount,
              deletions: 0,
              patch,
              viewed: false,
              commentCount: 0,
            },
          ],
        })
        .where(eq(megaCls.number, created.number));
      return created;
    }

    it("rejects an out-of-bounds line, an unknown file, and an invalid revision; accepts a valid anchor", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const cls = createClsService(client.db);
        const created = await seedClWithFile(cls, client, 5);

        await expect(
          cls.addInlineComment(created.number, { filePath: "src/app.ts", line: 1, body: "hi" }, null),
        ).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(
          cls.addInlineComment(created.number, { filePath: "src/app.ts", line: 1, body: "   " }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaBadRequestError);
        await expect(
          cls.addInlineComment(created.number, { filePath: "src/app.ts", line: 0, body: "hi" }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaBadRequestError);
        await expect(
          cls.addInlineComment(created.number, { filePath: "src/missing.ts", line: 1, body: "hi" }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaNotFoundError);

        // Patch has 5 lines — line 6 is out of bounds (AC2 "OOB line ... reject").
        await expect(
          cls.addInlineComment(created.number, { filePath: "src/app.ts", line: 6, body: "hi" }, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        // No revisions exist yet — an explicit revision number is invalid (AC2 "invalid revision ... reject").
        await expect(
          cls.addInlineComment(
            created.number,
            { filePath: "src/app.ts", line: 2, body: "hi", revision: 7 },
            USERS.tianjing.id,
          ),
        ).rejects.toBeInstanceOf(MegaBadRequestError);

        const rev = await cls.createCLRevision(created.number, { sha: "abc123" }, USERS.tianjing.id);
        const comment = await cls.addInlineComment(
          created.number,
          { filePath: "src/app.ts", line: 3, body: "Looks off by one.", revision: rev.number },
          USERS.eleanor.id,
        );
        expect(comment).toMatchObject({ filePath: "src/app.ts", line: 3, side: "additions", author: { id: USERS.eleanor.id } });

        const files = (await cls.getCL(created.number)).files;
        expect(files.find((file) => file.path === "src/app.ts")?.commentCount).toBe(1);

        const listed = await cls.listInlineComments(created.number);
        expect(listed.map((entry) => entry.id)).toEqual([comment.id]);

        await expect(cls.listInlineComments(999_999)).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });

    it("replyInlineComment stamps the latest revision; resolveInlineComment toggles resolvedAt", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const cls = createClsService(client.db);
        const created = await seedClWithFile(cls, client, 5);
        const rev1 = await cls.createCLRevision(created.number, { sha: "abc123" }, USERS.tianjing.id);
        const comment = await cls.addInlineComment(
          created.number,
          { filePath: "src/app.ts", line: 2, body: "Nit.", revision: rev1.number },
          USERS.tianjing.id,
        );

        await expect(cls.replyInlineComment(comment.id, "  ", USERS.eleanor.id)).rejects.toBeInstanceOf(
          MegaBadRequestError,
        );
        await expect(cls.replyInlineComment(comment.id, "ack", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(cls.replyInlineComment("inline_missing", "ack", USERS.eleanor.id)).rejects.toBeInstanceOf(
          MegaNotFoundError,
        );

        const rev2 = await cls.createCLRevision(created.number, { sha: "def456" }, USERS.tianjing.id);
        await expect(cls.replyInlineComment(comment.id, "ack", USERS.eleanor.id, created.number + 1))
          .rejects.toBeInstanceOf(MegaNotFoundError);
        const reply = await cls.replyInlineComment(comment.id, "Fixed in latest revision.", USERS.eleanor.id, created.number);
        expect(reply.revision).toBe(rev2.number);
        expect(reply.author.id).toBe(USERS.eleanor.id);

        const withReply = await cls.listInlineComments(created.number);
        expect(withReply[0]!.replies.map((r) => r.id)).toEqual([reply.id]);

        expect(await cls.resolveInlineComment("inline_missing", USERS.tianjing.id).catch((error) => error)).toBeInstanceOf(
          MegaNotFoundError,
        );
        await expect(cls.resolveInlineComment(comment.id, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(cls.resolveInlineComment(comment.id, USERS.tianjing.id, created.number + 1))
          .rejects.toBeInstanceOf(MegaNotFoundError);
        const resolved = await cls.resolveInlineComment(comment.id, USERS.tianjing.id, created.number);
        expect(resolved.resolvedAt).toBeDefined();
        const unresolved = await cls.resolveInlineComment(comment.id, USERS.tianjing.id);
        expect(unresolved.resolvedAt).toBeUndefined();
      } finally {
        await client.close();
      }
    });

    it("setCLFileViewed toggles a known file and 404s an unknown path", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const cls = createClsService(client.db);
        const created = await seedClWithFile(cls, client, 3);

        await expect(cls.setCLFileViewed(created.number, "src/app.ts", true, null)).rejects.toBeInstanceOf(
          MegaUnauthorizedError,
        );
        const viewed = await cls.setCLFileViewed(created.number, "src/app.ts", true, USERS.tianjing.id);
        expect(viewed.viewed).toBe(true);
        const reloaded = await cls.getCL(created.number);
        expect(reloaded.files.find((file) => file.path === "src/app.ts")?.viewed).toBe(true);

        await expect(
          cls.setCLFileViewed(created.number, "src/missing.ts", true, USERS.tianjing.id),
        ).rejects.toBeInstanceOf(MegaNotFoundError);
      } finally {
        await client.close();
      }
    });
  });
});
