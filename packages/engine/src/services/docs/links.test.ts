import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseClient,
  megaCls,
  megaClPublicIds,
  megaClCiStatuses,
  megaClMergeStates,
  megaClStates,
  megaContentContainerTypes,
  megaContentLinks,
  megaDocs,
  megaDocStatus,
  megaIssuePriorities,
  megaIssues,
  megaIssueStates,
} from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { SAMPLE_DOC, USERS } from "../../testing/fixtures";
import { createAclService } from "../acl";
import { createBlocksRepo } from "./blocks";
import {
  createLinksRepo,
  countReadableBlockReferences,
  encodeBlockTargetId,
  extractRefsFromEditorState,
  getTitleIndex,
  listBacklinks,
  listDocBacklinks,
  listDocUnlinked,
  rebuildDocLinks,
  resolveOrCreateDoc,
} from "./links";
import { createDocsService } from "./docs";

describe("extractRefsFromEditorState (EG-03, pure)", () => {
  it("returns an empty list without resolved refs", () => {
    const body = JSON.stringify({
      root: { children: [{ type: "mega-ref", ref: { kind: "doc", targetTitle: "Unresolved" } }] },
    });
    expect(extractRefsFromEditorState(body)).toEqual([]);
  });

  it("extracts a resolved mega-ref with the surrounding block's summary as context", () => {
    const body = JSON.stringify({
      root: {
        children: [
          {
            type: "mega-block",
            blockId: "blk_1_______",
            variant: "text",
            children: [
              { type: "text", text: "See " },
              { type: "mega-ref", ref: { kind: "doc", targetTitle: "Other doc", targetId: "doc_x" } },
            ],
          },
        ],
      },
    });
    const links = extractRefsFromEditorState(body);
    expect(links).toEqual([{ targetKind: "doc", targetId: "doc_x", contextSummary: "See Other doc" }]);
  });

  it("extracts a resolved mega-block-ref only when status is ok or absent", () => {
    const ok = JSON.stringify({
      root: {
        children: [
          { type: "mega-block-ref", blockRef: { targetDocId: "doc_x", targetBlockId: "blk_y_______", label: "Ref label" } },
        ],
      },
    });
    expect(extractRefsFromEditorState(ok)).toEqual([
      { targetKind: "block", targetId: encodeBlockTargetId("doc_x", "blk_y_______"), contextSummary: "Ref label" },
    ]);

    const unresolved = JSON.stringify({
      root: {
        children: [
          {
            type: "mega-block-ref",
            blockRef: { targetDocId: "doc_x", targetBlockId: "blk_y_______", label: "x", status: "unresolved" },
          },
        ],
      },
    });
    expect(extractRefsFromEditorState(unresolved)).toEqual([]);
  });

  it("indexes each block embed as one block reference", () => {
    const body = JSON.stringify({ root: { children: [
      { type: "mega-block", blockId: "host________", children: [
        { type: "mega-embed", embed: { targetDocId: "doc_x", targetBlockId: "blk_y_______" } },
        { type: "mega-embed", embed: { targetDocId: "doc_x", targetBlockId: "blk_y_______" } },
        { type: "mega-embed", embed: { targetDocId: "doc_x" } },
      ] },
    ] } });
    expect(extractRefsFromEditorState(body)).toEqual([
      { targetKind: "block", targetId: encodeBlockTargetId("doc_x", "blk_y_______"), contextSummary: "blk_y_______" },
      { targetKind: "block", targetId: encodeBlockTargetId("doc_x", "blk_y_______"), contextSummary: "blk_y_______" },
    ]);
  });

  it("skips refs with an unlinkable kind (e.g. user)", () => {
    const body = JSON.stringify({
      root: {
        children: [{ type: "mega-ref", ref: { kind: "user", targetTitle: "someone", targetId: "usr_x" } }],
      },
    });
    expect(extractRefsFromEditorState(body)).toEqual([]);
  });

  it("returns an empty list for invalid JSON", () => {
    expect(extractRefsFromEditorState("not json")).toEqual([]);
  });
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] docs/links.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] docs/links.test.ts: DATABASE_URL is unset — skipping PG links suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("links service (EG-03, throwaway PG)", () => {
  const testDbName = `megaui_test_links_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  it("counts saved embeds, removes deleted ones, and backfills legacy embeds once", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);
      const target = await docs.createDoc({ title: "Count target", body: JSON.stringify({
        root: { children: [{ type: "mega-block", blockId: "counted_____", variant: "text", children: [{ type: "text", text: "Target" }] }] },
      }) }, USERS.tianjing.id);
      const embed = { type: "mega-embed", embed: { targetDocId: target.id, targetBlockId: "counted_____" } };
      const bodyWith = (count: number) => JSON.stringify({ root: { children: [
        { type: "mega-block", blockId: "host________", variant: "text", children: Array.from({ length: count }, () => embed) },
      ] } });
      const source = await docs.createDoc({ title: "Count source", body: bodyWith(2) }, USERS.tianjing.id);
      expect(await countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", USERS.tianjing.id)).toBe(2);
      await client.db.insert(megaContentLinks).values({
        id: `stale_count_${source.id}`,
        sourceType: megaContentContainerTypes.DOC,
        sourceId: "doc_deleted_source",
        targetKind: "block",
        targetId: encodeBlockTargetId(target.id, "counted_____"),
        contextSummary: null,
      });
      expect(await countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", USERS.tianjing.id)).toBe(2);

      await docs.saveDoc(source.id, { body: bodyWith(1) }, USERS.tianjing.id);
      expect(await countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", USERS.tianjing.id)).toBe(1);

      await client.db.delete(megaContentLinks).where(and(
        eq(megaContentLinks.sourceType, megaContentContainerTypes.DOC),
        eq(megaContentLinks.sourceId, source.id),
      ));
      expect(await countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", USERS.tianjing.id)).toBe(0);
      const backfill = readFileSync(path.resolve(migrationsFolder, "0003_embed_block_references.sql"), "utf8");
      await client.db.execute(sql.raw(backfill));
      await client.db.execute(sql.raw(backfill));
      expect(await countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", USERS.tianjing.id)).toBe(1);

      await docs.saveDoc(source.id, { body: bodyWith(0) }, USERS.tianjing.id);
      expect(await countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", USERS.tianjing.id)).toBe(0);
      await expect(countReadableBlockReferences(client.db, linksRepo, acl, target.id, "counted_____", null))
        .rejects.toBeInstanceOf(MegaUnauthorizedError);
    } finally {
      await client.close();
    }
  });

  it("builds a workspace title index for signed-in users plus issues/CLs", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      await client.db.insert(megaIssues).values({
        id: "issue_1",
        number: 1,
        title: "First issue",
        state: megaIssueStates.OPEN,
        priority: megaIssuePriorities.P2,
        packageId: "pkg_engine",
        authorId: USERS.tianjing.id,
      });
      await client.db.insert(megaCls).values({
        id: "cl_title_idx",
        number: 42,
        title: "Some CL",
        state: megaClStates.WIP,
        packageId: "pkg_engine",
        authorId: USERS.tianjing.id,
        ci: megaClCiStatuses.QUEUED,
        merge: megaClMergeStates.NEEDS_REVIEW,
      });

      const publicId = "DocIndex42_a";
      await client.db.insert(megaClPublicIds).values({ number: 42, publicId });

      // Signed-in workspace users can see the seeded doc without a collaborator row.
      const ownerIndex = await getTitleIndex(client.db, acl, USERS.tianjing.id);
      expect(ownerIndex.some((entry) => entry.kind === "doc" && entry.targetId === SAMPLE_DOC.id)).toBe(true);
      expect(ownerIndex.some((entry) => entry.kind === "issue" && entry.targetId === "1")).toBe(true);
      expect(ownerIndex.some((entry) => entry.kind === "cl" && entry.targetId === publicId && entry.detail === publicId)).toBe(true);

      const blocks = createBlocksRepo(client.db);
      const links = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocks, links);
      const body = JSON.stringify({ root: { children: [{
        type: "mega-block", blockId: "cl_ref_block", variant: "text", children: [
          { type: "text", text: "Some CL" },
          { type: "mega-ref", ref: { kind: "cl", targetTitle: "Some CL", targetId: "42" } },
        ],
      }] } });
      const source = await docs.createDoc({ title: "Legacy CL reference", body }, USERS.tianjing.id);
      const canonicalBacklinks = await listBacklinks(client.db, links, blocks, acl, "cl", publicId, USERS.tianjing.id);
      expect(canonicalBacklinks.items).toContainEqual(expect.objectContaining({ sourceId: source.id }));
      expect(await listBacklinks(client.db, links, blocks, acl, "cl", "42", USERS.tianjing.id)).toEqual(canonicalBacklinks);
      const unlinked = await listDocUnlinked(client.db, acl, body, source.id, USERS.tianjing.id);
      expect(unlinked.items.some(item => item.kind === "cl" && item.targetId === publicId)).toBe(false);

      const strangerIndex = await getTitleIndex(client.db, acl, USERS.rafael.id);
      expect(strangerIndex.some((entry) => entry.kind === "doc" && entry.targetId === SAMPLE_DOC.id)).toBe(true);
      // Issues/CLs have no ACL model yet (registered omission) — visible regardless.
      expect(strangerIndex.some((entry) => entry.kind === "issue" && entry.targetId === "1")).toBe(true);

      const anonymousIndex = await getTitleIndex(client.db, acl, null);
      expect(anonymousIndex.some((entry) => entry.kind === "doc")).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rebuilds links, resolves backlinks for docs/issues/CLs, and supports block-scoped backlinks", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);

      await client.db.insert(megaIssues).values({
        id: "issue_bk",
        number: 7,
        title: "Backlink issue",
        state: megaIssueStates.OPEN,
        priority: megaIssuePriorities.P2,
        packageId: "pkg_engine",
        authorId: USERS.tianjing.id,
      });

      // A separate doc that links to SAMPLE_DOC (page-level) and to issue #7.
      const sourceDocId = "doc_links_source";
      const now = new Date();
      await client.db.insert(megaDocs).values({
        id: sourceDocId,
        title: "Source doc",
        authorId: USERS.tianjing.id,
        status: megaDocStatus.DRAFT,
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      const linkingBody = JSON.stringify({
        root: {
          children: [
            {
              type: "mega-block",
              blockId: "blk_source__",
              variant: "text",
              children: [
                { type: "mega-ref", ref: { kind: "doc", targetTitle: SAMPLE_DOC.title, targetId: SAMPLE_DOC.id } },
                { type: "mega-ref", ref: { kind: "issue", targetTitle: "Backlink issue", targetId: "7" } },
              ],
            },
          ],
        },
      });
      await rebuildDocLinks(linksRepo, sourceDocId, linkingBody);

      const docBacklinks = await listBacklinks(client.db, linksRepo, blocksRepo, acl, "doc", SAMPLE_DOC.id, USERS.tianjing.id);
      expect(docBacklinks.items).toHaveLength(1);
      expect(docBacklinks.items[0]).toMatchObject({ sourceType: megaContentContainerTypes.DOC, sourceId: sourceDocId });

      const issueBacklinks = await listBacklinks(client.db, linksRepo, blocksRepo, acl, "issue", "7", USERS.tianjing.id);
      expect(issueBacklinks.items).toHaveLength(1);
      expect(issueBacklinks.items[0]).toMatchObject({ sourceId: sourceDocId, href: expect.stringContaining("/docs/") });

      await expect(
        listBacklinks(client.db, linksRepo, blocksRepo, acl, "doc", "doc_does_not_exist", USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaNotFoundError);

      // Block-scoped backlink: rebuild a block index for SAMPLE_DOC, then link to it.
      await blocksRepo.rebuildForSource(
        megaContentContainerTypes.DOC,
        SAMPLE_DOC.id,
        JSON.stringify({
          root: { children: [{ type: "mega-block", blockId: "blk_target__", variant: "text", children: [{ type: "text", text: "Target block" }] }] },
        }),
      );
      const blockRefBody = JSON.stringify({
        root: {
          children: [
            {
              type: "mega-block-ref",
              blockRef: { targetDocId: SAMPLE_DOC.id, targetBlockId: "blk_target__", label: "Target block" },
            },
          ],
        },
      });
      await rebuildDocLinks(linksRepo, sourceDocId, blockRefBody);
      const withBlock = await listDocBacklinks(client.db, linksRepo, blocksRepo, acl, SAMPLE_DOC.id, USERS.tianjing.id);
      expect(withBlock.items.some((item) => item.targetBlockId === "blk_target__")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("listBacklinks/listDocBacklinks expose workspace docs and sources to signed-in users", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      // A workspace doc can be read by another signed-in user.
      const privateTarget = await docs.createDoc(
        { title: "Private backlink target", body: createEmptyMegaDocumentEditorStateJSON() },
        USERS.eleanor.id,
      );

      await expect(
        listBacklinks(client.db, linksRepo, blocksRepo, acl, "doc", privateTarget.id, USERS.rafael.id),
      ).resolves.toMatchObject({ items: [] });
      await expect(
        listBacklinks(client.db, linksRepo, blocksRepo, acl, "doc", privateTarget.id, null),
      ).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(
        listDocBacklinks(client.db, linksRepo, blocksRepo, acl, privateTarget.id, USERS.rafael.id),
      ).resolves.toMatchObject({ items: [] });

      // A workspace source doc links to a public issue and remains visible.
      await client.db.insert(megaIssues).values({
        id: "issue_private_source_bk",
        number: 77,
        title: "Private-source backlink issue",
        state: megaIssueStates.OPEN,
        priority: megaIssuePriorities.P2,
        packageId: "pkg_engine",
        authorId: USERS.tianjing.id,
      });
      const privateSourceDoc = await docs.createDoc(
        {
          title: "Private source doc",
          body: JSON.stringify({
            root: {
              children: [
                {
                  type: "mega-block",
                  blockId: "blk_priv_src",
                  variant: "text",
                  children: [
                    {
                      type: "mega-ref",
                      ref: { kind: "issue", targetTitle: "Private-source backlink issue", targetId: "77" },
                    },
                  ],
                },
              ],
            },
          }),
        },
        USERS.eleanor.id,
      );

      const ownerView = await listBacklinks(client.db, linksRepo, blocksRepo, acl, "issue", "77", USERS.eleanor.id);
      expect(ownerView.items.some((item) => item.sourceId === privateSourceDoc.id)).toBe(true);

      const strangerView = await listBacklinks(client.db, linksRepo, blocksRepo, acl, "issue", "77", USERS.rafael.id);
      expect(strangerView.items.some((item) => item.sourceId === privateSourceDoc.id)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("resolveOrCreateDoc finds an existing live doc by title or creates a new one", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const existing = await resolveOrCreateDoc(
        client.db,
        linksRepo,
        acl,
        (input, actorUserId) => docs.createEmptyDoc(input, actorUserId),
        SAMPLE_DOC.title,
        USERS.tianjing.id,
      );
      expect(existing).toEqual({ targetId: SAMPLE_DOC.id, title: SAMPLE_DOC.title, created: false });

      const created = await resolveOrCreateDoc(
        client.db,
        linksRepo,
        acl,
        (input, actorUserId) => docs.createEmptyDoc(input, actorUserId),
        "Brand new page",
        USERS.tianjing.id,
      );
      expect(created.created).toBe(true);
      expect(created.title).toBe("Brand new page");

      const foundAfterCreate = await resolveOrCreateDoc(
        client.db,
        linksRepo,
        acl,
        (input, actorUserId) => docs.createEmptyDoc(input, actorUserId),
        "Brand new page",
        USERS.tianjing.id,
      );
      expect(foundAfterCreate).toEqual({ targetId: created.targetId, title: "Brand new page", created: false });
    } finally {
      await client.close();
    }
  });

  it("resolveOrCreateDoc returns an existing workspace doc to a signed-in user", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const workspaceDoc = await docs.createDoc(
        { title: "Workspace wikilink target", body: createEmptyMegaDocumentEditorStateJSON() },
        USERS.eleanor.id,
      );

      const resolved = await resolveOrCreateDoc(
        client.db,
        linksRepo,
        acl,
        (input, actorUserId) => docs.createEmptyDoc(input, actorUserId),
        "Workspace wikilink target",
        USERS.rafael.id,
      );
      expect(resolved).toEqual({ targetId: workspaceDoc.id, title: workspaceDoc.title, created: false });
    } finally {
      await client.close();
    }
  });

  it("listDocUnlinked surfaces plain-text mentions of known titles that are not yet [[linked]]", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const mentioningBody = JSON.stringify({
        root: {
          children: [
            {
              type: "mega-block",
              blockId: "blk_mention_",
              variant: "text",
              children: [{ type: "text", text: `See ${SAMPLE_DOC.title} for background.` }],
            },
          ],
        },
      });
      const result = await listDocUnlinked(client.db, acl, mentioningBody, "doc_other", USERS.tianjing.id);
      expect(result.items.some((item) => item.kind === "doc" && item.targetId === SAMPLE_DOC.id)).toBe(true);
    } finally {
      await client.close();
    }
  });
});
