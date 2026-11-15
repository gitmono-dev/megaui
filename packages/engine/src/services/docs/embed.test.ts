import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaDocCollaboratorRoles, megaDocCollaborators } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../../seed";
import { SAMPLE_DOC, USERS } from "../../testing/fixtures";
import { createAclService } from "../acl";
import { createBlocksRepo } from "./blocks";
import { createDocsService } from "./docs";
import { extractEmbedsFromEditorState, resolveEmbed } from "./embed";
import { createLinksRepo } from "./links";

describe("extractEmbedsFromEditorState (EG-03, pure)", () => {
  it("returns an empty list without mega-embed nodes", () => {
    expect(extractEmbedsFromEditorState('{"root":{"children":[]}}')).toEqual([]);
  });

  it("extracts page and block embeds", () => {
    const body = JSON.stringify({
      root: {
        children: [
          { type: "mega-embed", embed: { targetDocId: "doc_page" } },
          { type: "mega-embed", embed: { targetDocId: "doc_block", targetBlockId: "blk_1_______" } },
        ],
      },
    });
    expect(extractEmbedsFromEditorState(body)).toEqual([
      { targetDocId: "doc_page", targetBlockId: null },
      { targetDocId: "doc_block", targetBlockId: "blk_1_______" },
    ]);
  });

  it("returns an empty list for invalid JSON", () => {
    expect(extractEmbedsFromEditorState("nope")).toEqual([]);
  });
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] docs/embed.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] docs/embed.test.ts: DATABASE_URL is unset — skipping PG embed suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function megaEmbedBody(targetDocId: string, targetBlockId?: string): string {
  return JSON.stringify({
    root: {
      children: [
        {
          type: "mega-block",
          blockId: "75a5fa03a2b5",
          variant: "text",
          children: [{ type: "mega-embed", embed: { targetDocId, ...(targetBlockId ? { targetBlockId } : {}) } }],
        },
      ],
    },
  });
}

describe.skipIf(!adminDatabaseUrl)("resolveEmbed (EG-03, throwaway PG)", () => {
  const testDbName = `megaui_test_embed_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  it("resolves a workspace doc for another signed-in actor", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const result = await resolveEmbed(client.db, acl, SAMPLE_DOC.id, null, USERS.rafael.id);
      expect(result).toMatchObject({ access: "ok", status: "ok" });
    } finally {
      await client.close();
    }
  });

  it("resolves an unresolved embed for a missing doc", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const result = await resolveEmbed(client.db, acl, "doc_does_not_exist", null, USERS.tianjing.id);
      expect(result).toMatchObject({ access: "ok", status: "unresolved" });
    } finally {
      await client.close();
    }
  });

  it("resolves a page embed chain and reports depth/ancestor chain", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const leaf = await docs.createDoc({ title: "Embed leaf", body: '{"root":{"children":[]}}' }, USERS.tianjing.id);
      const middle = await docs.createDoc(
        { title: "Embed middle", body: megaEmbedBody(leaf.id) },
        USERS.tianjing.id,
      );
      const root = await docs.createDoc({ title: "Embed root", body: megaEmbedBody(middle.id) }, USERS.tianjing.id);

      const result = await resolveEmbed(client.db, acl, root.id, null, USERS.tianjing.id);
      expect(result.access).toBe("ok");
      expect(result.status).toBe("ok");
      expect(result.depth).toBe(2);
      expect(result.ancestorChain.map((entry) => entry.docId)).toEqual([root.id, middle.id, leaf.id]);
    } finally {
      await client.close();
    }
  });

  it("detects a cycle when two docs embed each other", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const a = await docs.createDoc({ title: "Cycle A", body: '{"root":{"children":[]}}' }, USERS.tianjing.id);
      const b = await docs.createDoc({ title: "Cycle B", body: megaEmbedBody(a.id) }, USERS.tianjing.id);
      await docs.saveDoc(a.id, { body: megaEmbedBody(b.id) }, USERS.tianjing.id);

      const result = await resolveEmbed(client.db, acl, a.id, null, USERS.tianjing.id);
      expect(result.status).toBe("cycle");
      expect(result.cycle).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("reports too_deep past EMBED_MAX_DEPTH and stops descending further", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      let previous = await docs.createDoc({ title: "Depth 0", body: '{"root":{"children":[]}}' }, USERS.tianjing.id);
      for (let level = 1; level <= 5; level += 1) {
        previous = await docs.createDoc(
          { title: `Depth ${level}`, body: megaEmbedBody(previous.id) },
          USERS.tianjing.id,
        );
      }

      const result = await resolveEmbed(client.db, acl, previous.id, null, USERS.tianjing.id);
      expect(result.status).toBe("too_deep");
      expect(result.tooDeep).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("resolves a block-scoped embed to just that block's subtree", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const target = await docs.createDoc(
        {
          title: "Block embed target",
          body: JSON.stringify({
            root: {
              children: [
                { type: "mega-block", blockId: "blk_only____", variant: "text", children: [{ type: "text", text: "Only block" }] },
              ],
            },
          }),
        },
        USERS.tianjing.id,
      );

      const result = await resolveEmbed(client.db, acl, target.id, "blk_only____", USERS.tianjing.id);
      expect(result.status).toBe("ok");
      expect(result.snapshotBody).toContain("blk_only____");
      expect(result.snapshotBody).not.toBe(result.containerBody);

      const missingBlock = await resolveEmbed(client.db, acl, target.id, "blk_missing_", USERS.tianjing.id);
      expect(missingBlock.status).toBe("unresolved");
    } finally {
      await client.close();
    }
  });

  it("collaborators can resolve embeds on docs they don't own", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      await client.db.insert(megaDocCollaborators).values({
        id: `collab_embed_${SAMPLE_DOC.id}_${USERS.rafael.id}`,
        docId: SAMPLE_DOC.id,
        userId: USERS.rafael.id,
        role: megaDocCollaboratorRoles.VIEWER,
      });
      const result = await resolveEmbed(client.db, acl, SAMPLE_DOC.id, null, USERS.rafael.id);
      expect(result.access).toBe("ok");
    } finally {
      await client.close();
    }
  });
});
