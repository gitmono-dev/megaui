import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaContentContainerTypes } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBlocksRepo, extractBlocksFromEditorState, listBlocksForDoc, rebuildDocBlocks, deleteBlocksForDoc } from "./blocks";

describe("extractBlocksFromEditorState (EG-03, pure)", () => {
  it("returns an empty list for a document with no indexable blocks", () => {
    expect(extractBlocksFromEditorState('{"root":{"children":[]}}')).toEqual([]);
  });

  it("returns an empty list for invalid JSON", () => {
    expect(extractBlocksFromEditorState("not json")).toEqual([]);
  });

  it("extracts a nested mega-block tree with depth and parentBlockId", () => {
    const body = JSON.stringify({
      root: {
        children: [
          {
            type: "mega-block",
            blockId: "blk_a_______",
            variant: "h1",
            children: [{ type: "text", text: "Heading" }],
          },
          {
            type: "mega-block",
            blockId: "blk_b_______",
            variant: "text",
            listKind: "bullet",
            children: [
              { type: "text", text: "Child bullet" },
              {
                type: "mega-block",
                blockId: "blk_c_______",
                variant: "todo",
                todoChecked: true,
                children: [{ type: "text", text: "Nested todo" }],
              },
            ],
          },
        ],
      },
    });
    const blocks = extractBlocksFromEditorState(body);
    expect(blocks).toHaveLength(3);
    const byId = new Map(blocks.map((block) => [block.blockId, block]));
    expect(byId.get("blk_a_______")).toMatchObject({ depth: 0, parentBlockId: null, variant: "heading", textSummary: "Heading" });
    expect(byId.get("blk_b_______")).toMatchObject({ depth: 0, parentBlockId: null, variant: "bullet" });
    expect(byId.get("blk_c_______")).toMatchObject({ depth: 1, parentBlockId: "blk_b_______", variant: "todo" });
  });

  it("maps code/table/hr leaf containers and truncates long text summaries", () => {
    const longText = "x".repeat(500);
    const body = JSON.stringify({
      root: {
        children: [
          { type: "mega-code-block", blockId: "blk_code____", children: [{ type: "text", text: longText }] },
          { type: "mega-table-block", blockId: "blk_table___", children: [] },
          { type: "mega-hr-block", blockId: "blk_hr______", children: [] },
        ],
      },
    });
    const blocks = extractBlocksFromEditorState(body);
    const byId = new Map(blocks.map((block) => [block.blockId, block]));
    expect(byId.get("blk_code____")?.variant).toBe("code");
    expect(byId.get("blk_code____")?.textSummary.length).toBeLessThanOrEqual(120);
    expect(byId.get("blk_table___")?.variant).toBe("paragraph");
    expect(byId.get("blk_hr______")?.variant).toBe("paragraph");
  });

  it("skips non-indexable wrapper nodes but still descends into their children", () => {
    const body = JSON.stringify({
      root: {
        children: [
          {
            type: "some-wrapper",
            children: [{ type: "mega-block", blockId: "blk_deep____", variant: "text", children: [] }],
          },
        ],
      },
    });
    const blocks = extractBlocksFromEditorState(body);
    expect(blocks.map((b) => b.blockId)).toEqual(["blk_deep____"]);
    expect(blocks[0]?.depth).toBe(0);
    expect(blocks[0]?.parentBlockId).toBeNull();
  });
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] docs/blocks.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] docs/blocks.test.ts: DATABASE_URL is unset — skipping PG blocks suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("createBlocksRepo (EG-03, throwaway PG)", () => {
  const testDbName = `megaui_test_blocks_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: import("pg").Pool;
  let connectionString: string;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
    const migratePool = new Pool({ connectionString });
    try {
      await migrate(
        (await import("drizzle-orm/node-postgres")).drizzle(migratePool),
        { migrationsFolder },
      );
    } finally {
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

  it("rebuilds, lists, and full-replaces the block index for a source, then deletes it", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const repo = createBlocksRepo(client.db);
      const docId = "doc_blocks_1";

      const bodyV1 = JSON.stringify({
        root: {
          children: [{ type: "mega-block", blockId: "blk_1_______", variant: "text", children: [{ type: "text", text: "First" }] }],
        },
      });
      const extractedV1 = await rebuildDocBlocks(repo, docId, bodyV1);
      expect(extractedV1).toHaveLength(1);

      const listed = await listBlocksForDoc(repo, docId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ blockId: "blk_1_______", textSummary: "First" });

      // Full replace: rebuilding with a different body drops the stale block row.
      const bodyV2 = JSON.stringify({
        root: {
          children: [{ type: "mega-block", blockId: "blk_2_______", variant: "quote", children: [{ type: "text", text: "Second" }] }],
        },
      });
      await rebuildDocBlocks(repo, docId, bodyV2);
      const relisted = await listBlocksForDoc(repo, docId);
      expect(relisted.map((row) => row.blockId)).toEqual(["blk_2_______"]);

      await deleteBlocksForDoc(repo, docId);
      expect(await listBlocksForDoc(repo, docId)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("scopes rebuild/list/delete by (sourceType, sourceId) independently", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const repo = createBlocksRepo(client.db);
      const body = JSON.stringify({
        root: { children: [{ type: "mega-block", blockId: "blk_shared__", variant: "text", children: [] }] },
      });
      await repo.rebuildForSource(megaContentContainerTypes.DOC, "doc_a", body);
      await repo.rebuildForSource(megaContentContainerTypes.DOC, "doc_b", body);

      expect(await listBlocksForDoc(repo, "doc_a")).toHaveLength(1);
      expect(await listBlocksForDoc(repo, "doc_b")).toHaveLength(1);

      await deleteBlocksForDoc(repo, "doc_a");
      expect(await listBlocksForDoc(repo, "doc_a")).toEqual([]);
      expect(await listBlocksForDoc(repo, "doc_b")).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
