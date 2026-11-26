import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaDocCollaboratorRoles, megaDocCollaborators } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MegaBadRequestError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaTitleConflictError,
  MegaUnauthorizedError,
} from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { SAMPLE_DOC, USERS } from "../../testing/fixtures";
import { createAclService } from "../acl";
import { createBlocksRepo, listBlocksForDoc } from "./blocks";
import { createDocsService } from "./docs";
import { createLinksRepo } from "./links";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] docs/docs.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] docs/docs.test.ts: DATABASE_URL is unset — skipping PG docs suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

const EMPTY_BODY = '{"root":{"children":[]}}';

describe.skipIf(!adminDatabaseUrl)("createDocsService CRUD/rename/version/star (EG-03, throwaway PG)", () => {
  const testDbName = `megaui_test_docs_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  it("creates a doc with an owner collaborator and a v1 version", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));

      const created = await docs.createDoc({ title: "New doc", body: EMPTY_BODY, excerpt: "hello" }, USERS.tianjing.id);
      expect(created.title).toBe("New doc");
      expect(created.author.id).toBe(USERS.tianjing.id);
      expect(created.collaborators.map((c) => c.id)).toEqual([USERS.tianjing.id]);
      expect(created.versions).toHaveLength(1);
      expect(created.versions[0]).toMatchObject({ version: 1, summary: "Created document" });
      expect(created.starred).toBe(false);
      expect(created.status).toBe("draft");

      const fetched = await docs.getDoc(created.id, USERS.tianjing.id);
      expect(fetched).toEqual(created);
    } finally {
      await client.close();
    }
  });

  it("persists Roam macro and image source through document creation, save and reload", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const docs = createDocsService(client.db, createAclService(client.db), createBlocksRepo(client.db), createLinksRepo(client.db));
      const macroBlock = (blockId: string, children: unknown[]) => ({
        type: 'mega-block', version: 1, blockId, variant: 'text', collapsed: false,
        direction: null, format: '', indent: 0, children,
      });
      const source = JSON.stringify({ root: { type: 'root', version: 1, children: [
        macroBlock('abcdefghijkl', [{ type: 'mega-roam-macro', version: 1, text: '{{[[TODO]]}}' }]),
        macroBlock('mnopqrstuvwx', [
          { type: 'mega-roam-macro', version: 1, text: '{{[[table]]}}' },
          macroBlock('ABCDEFGHIJKL', [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: 'cell' }] }, macroBlock('ABCDEFGHIJ03', [])]),
          macroBlock('ABCDEFGHIJ01', [{ type: 'mega-image', version: 1, text: '![图标](http://127.0.0.1:3000/favicon.ico)' }]),
        ]),
        macroBlock('ABCDEFGHIJ02', [{ type: 'mega-embed', version: 1, text: '{{[[embed]]: [[协作保存验证]]}}', targetDocId: 'doc_target', label: '协作保存验证' }]),
      ] } });
      const created = await docs.createDoc({ title: 'Roam source persistence', body: source }, USERS.tianjing.id);
      const done = source.replace('{{[[TODO]]}}', '{{[[DONE]]}}');
      await docs.saveDoc(created.id, { body: done, summary: 'Completed task' }, USERS.tianjing.id);
      const fetched = await docs.getDoc(created.id, USERS.tianjing.id);
      expect(JSON.parse(fetched.body)).toEqual(JSON.parse(done));
      expect(JSON.parse(fetched.versions[0]!.body!)).toEqual(JSON.parse(done));
      const indexed = await listBlocksForDoc(createBlocksRepo(client.db), created.id);
      expect(indexed.find(item => item.blockId === 'abcdefghijkl')?.variant).toBe('todo');
    } finally {
      await client.close();
    }
  });

  it("rejects createDoc for an unauthenticated actor", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      await expect(docs.createDoc({ title: "Anon doc", body: EMPTY_BODY }, null)).rejects.toBeInstanceOf(
        MegaUnauthorizedError,
      );
    } finally {
      await client.close();
    }
  });

  it("enforces live-title uniqueness on create and rename (MegaTitleConflictError)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));

      await docs.createDoc({ title: "Unique title A", body: EMPTY_BODY }, USERS.tianjing.id);
      await expect(
        docs.createDoc({ title: "Unique title A", body: EMPTY_BODY }, USERS.rafael.id),
      ).rejects.toBeInstanceOf(MegaTitleConflictError);

      const other = await docs.createDoc({ title: "Unique title B", body: EMPTY_BODY }, USERS.tianjing.id);
      await expect(docs.renameDoc(other.id, "Unique title A", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaTitleConflictError,
      );

      const renamed = await docs.renameDoc(other.id, "Unique title B renamed", USERS.tianjing.id);
      expect(renamed.title).toBe("Unique title B renamed");
    } finally {
      await client.close();
    }
  });

  it("races saveDoc({title}) vs saveDoc({body}) and never lets one silently revert the other's write (P0 lost-update fix)", async () => {
    const client = createDatabaseClient({ connectionString, max: 10 });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Race original title", body: EMPTY_BODY }, USERS.tianjing.id);

      const newTitle = "Race new title";
      const newBody = JSON.stringify({
        root: {
          children: [
            {
              type: "mega-block",
              blockId: "blk_race____",
              variant: "text",
              children: [{ type: "text", text: "race body", detail: 0, format: 0, mode: "normal", style: "", version: 1 }],
            },
          ],
        },
      });

      await Promise.all([
        docs.saveDoc(created.id, { title: newTitle }, USERS.tianjing.id),
        docs.saveDoc(created.id, { body: newBody }, USERS.tianjing.id),
      ]);

      const finalDoc = await docs.getDoc(created.id, USERS.tianjing.id);
      expect(finalDoc.title).toBe(newTitle);
      // `jsonb` round-trips may reorder object keys, so compare parsed shape.
      expect(JSON.parse(finalDoc.body)).toEqual(JSON.parse(newBody));
    } finally {
      await client.close();
    }
  });

  it("saveDoc without summary autosaves body only; with summary snapshots a new version", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Save doc", body: EMPTY_BODY }, USERS.tianjing.id);

      const autosaved = await docs.saveDoc(
        created.id,
        { body: JSON.stringify({ root: { children: [{ type: "text", text: "draft" }] } }) },
        USERS.tianjing.id,
      );
      expect(autosaved.versions).toHaveLength(1);

      const versioned = await docs.saveDoc(
        created.id,
        {
          body: JSON.stringify({ root: { children: [{ type: "text", text: "final" }] } }),
          summary: "First real edit",
        },
        USERS.tianjing.id,
      );
      expect(versioned.versions).toHaveLength(2);
      expect(versioned.versions[0]).toMatchObject({ version: 2, summary: "First real edit" });
    } finally {
      await client.close();
    }
  });

  it("serializes concurrent versioned saves on the same doc into unique, gapless versions (concurrent save conflict semantics)", async () => {
    const client = createDatabaseClient({ connectionString, max: 10 });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Conflict doc", body: EMPTY_BODY }, USERS.tianjing.id);

      // `saveDoc`'s transaction unconditionally row-locks `megaDocs` for
      // `id` before computing the next version, so N concurrent racers on
      // the same doc are serialized by Postgres rather than corrupting data:
      // every racer must land a distinct, contiguous version number and none
      // may be silently dropped or overwritten.
      const RACERS = 10;
      await Promise.all(
        Array.from({ length: RACERS }, (_, index) =>
          docs.saveDoc(created.id, { body: EMPTY_BODY, summary: `Race ${index}` }, USERS.tianjing.id),
        ),
      );

      // Each racer's own `saveDoc` return value reflects a post-commit
      // re-read (which can race with a *later* committer's write), so assert
      // against the final persisted state instead of individual return values.
      const finalDoc = await docs.getDoc(created.id, USERS.tianjing.id);
      expect(finalDoc.versions).toHaveLength(1 + RACERS);
      const versionNumbers = finalDoc.versions.map((version) => version.version);
      expect(new Set(versionNumbers).size).toBe(versionNumbers.length);
      expect([...versionNumbers].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 1 + RACERS }, (_, index) => index + 1),
      );
    } finally {
      await client.close();
    }
  });

  it("maps a duplicate (docId, version) row to the unique index saveDoc's MegaConflictError catch relies on", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Unique version doc", body: EMPTY_BODY }, USERS.tianjing.id);

      const { megaDocVersions } = await import("@megaui/database");
      await expect(
        client.db.insert(megaDocVersions).values({
          id: "dup_version_row",
          docId: created.id,
          version: 1, // already taken by the v1 create snapshot
          authorId: USERS.tianjing.id,
          summary: "Duplicate",
          snapshotRef: EMPTY_BODY,
          createdAt: new Date(),
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    } finally {
      await client.close();
    }
  });

  it("toggleDocStar survives a concurrent race for the same (docId, userId) without leaking a raw PG unique violation", async () => {
    const client = createDatabaseClient({ connectionString, max: 10 });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Star race doc", body: EMPTY_BODY }, USERS.tianjing.id);

      const RACERS = 8;
      const results = await Promise.all(
        Array.from({ length: RACERS }, () => docs.toggleDocStar(created.id, USERS.tianjing.id)),
      );
      expect(results.every((doc) => typeof doc.starred === "boolean")).toBe(true);

      // Regardless of interleaving, exactly one star row exists for this (docId, userId).
      const { megaDocStars } = await import("@megaui/database");
      const { eq, and } = await import("drizzle-orm");
      const starRows = await client.db
        .select({ id: megaDocStars.id })
        .from(megaDocStars)
        .where(and(eq(megaDocStars.docId, created.id), eq(megaDocStars.userId, USERS.tianjing.id)));
      expect(starRows.length).toBeLessThanOrEqual(1);
    } finally {
      await client.close();
    }
  });

  it("toggleDocStar flips a per-viewer star without affecting other viewers", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Star doc", body: EMPTY_BODY }, USERS.tianjing.id);

      expect((await docs.getDoc(created.id, USERS.tianjing.id)).starred).toBe(false);
      const starred = await docs.toggleDocStar(created.id, USERS.tianjing.id);
      expect(starred.starred).toBe(true);

      const unstarred = await docs.toggleDocStar(created.id, USERS.tianjing.id);
      expect(unstarred.starred).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("updateDocMeta updates the lifecycle status", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Status doc", body: EMPTY_BODY }, USERS.tianjing.id);
      expect(created.status).toBe("draft");

      const published = await docs.updateDocMeta(created.id, { status: "published" }, USERS.tianjing.id);
      expect(published.status).toBe("published");
      expect(published.versions).toHaveLength(2);
      expect(published.versions[0]).toMatchObject({ summary: "Published document", body: created.body });
      const repeated = await Promise.all([1, 2].map(() => docs.updateDocMeta(created.id, { status: "published" }, USERS.tianjing.id)));
      expect(repeated.every(doc => doc.versions.length === 2)).toBe(true);
      const saved = await docs.saveDoc(created.id, { title: "Published title edited" }, USERS.tianjing.id);
      expect(saved.status).toBe("published");
      const draft = await docs.updateDocMeta(created.id, { status: "draft" }, USERS.tianjing.id);
      expect(draft.status).toBe("draft");
      expect(draft.versions).toHaveLength(2);
      expect((await docs.getDoc(created.id, USERS.tianjing.id)).status).toBe("draft");
      expect((await docs.updateDocMeta(created.id, { status: "published" }, USERS.tianjing.id)).versions).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it("denies publication to anonymous and viewer actors without changing status or versions", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const docs = createDocsService(client.db, createAclService(client.db), createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "Publication permissions", body: EMPTY_BODY }, USERS.tianjing.id);
      await client.db.insert(megaDocCollaborators).values({ id: randomUUID(), docId: created.id, userId: USERS.rafael.id, role: megaDocCollaboratorRoles.VIEWER });
      for (const status of ["published", "draft"] as const) {
        await expect(docs.updateDocMeta(created.id, { status }, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(docs.updateDocMeta(created.id, { status }, USERS.rafael.id)).rejects.toBeInstanceOf(MegaForbiddenError);
      }
      const unchanged = await docs.getDoc(created.id, USERS.tianjing.id);
      expect(unchanged).toMatchObject({ status: "draft", canEdit: true });
      expect(unchanged.versions).toHaveLength(1);
      expect(await docs.getDoc(created.id, USERS.rafael.id)).toMatchObject({ canEdit: false });
      await expect(docs.updateDocMeta("missing-publication-doc", { status: "published" }, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
    } finally {
      await client.close();
    }
  });

  it("registerDocView increments the view counter for workspace readers", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "View doc", body: EMPTY_BODY }, USERS.tianjing.id);
      expect(created.viewCount).toBe(0);

      const viewed = await docs.registerDocView(created.id, USERS.tianjing.id);
      expect(viewed.viewCount).toBe(1);

      await expect(docs.registerDocView(created.id, USERS.rafael.id)).resolves.toMatchObject({ viewCount: 2 });
    } finally {
      await client.close();
    }
  });

  it("deleteDoc soft-deletes and removes its block/link index; write/manage require the right role", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const created = await docs.createDoc(
        {
          title: "Delete doc",
          body: JSON.stringify({
            root: { children: [{ type: "mega-block", blockId: "blk_del_____", variant: "text", children: [{ type: "text", text: "x" }] }] },
          }),
        },
        USERS.tianjing.id,
      );
      expect(await listBlocksForDoc(blocksRepo, created.id)).toHaveLength(1);

      await client.db.insert(megaDocCollaborators).values({
        id: `collab_${created.id}_${USERS.eleanor.id}`,
        docId: created.id,
        userId: USERS.eleanor.id,
        role: megaDocCollaboratorRoles.EDITOR,
      });

      // Editor collaborators can write but not manage (delete).
      await expect(docs.saveDoc(created.id, { excerpt: "edited" }, USERS.eleanor.id)).resolves.toMatchObject({
        excerpt: "edited",
      });
      await expect(docs.deleteDoc(created.id, USERS.eleanor.id)).rejects.toBeInstanceOf(MegaForbiddenError);

      await docs.deleteDoc(created.id, USERS.tianjing.id);
      await expect(docs.getDoc(created.id, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
      expect(await listBlocksForDoc(blocksRepo, created.id)).toEqual([]);
      await expect(docs.deleteDoc(created.id, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
    } finally {
      await client.close();
    }
  });

  it("listDocs exposes docs to every signed-in workspace user", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "List-scoped doc", body: EMPTY_BODY }, USERS.tianjing.id);

      const ownerList = await docs.listDocs(USERS.tianjing.id);
      expect(ownerList.some((doc) => doc.id === created.id)).toBe(true);

      const strangerList = await docs.listDocs(USERS.rafael.id);
      expect(strangerList.some((doc) => doc.id === created.id)).toBe(true);
      expect(strangerList.some((doc) => doc.id === SAMPLE_DOC.id)).toBe(true);

      const anonymousList = await docs.listDocs(null);
      expect(anonymousList).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("rebuilds the block and link index after create/save (backlinks/blocks integration)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const created = await docs.createDoc(
        {
          title: "Rebuild doc",
          body: JSON.stringify({
            root: {
              children: [
                {
                  type: "mega-block",
                  blockId: "blk_rebuild_",
                  variant: "text",
                  children: [
                    { type: "text", text: "See " },
                    { type: "mega-ref", ref: { kind: "doc", targetTitle: SAMPLE_DOC.title, targetId: SAMPLE_DOC.id } },
                  ],
                },
              ],
            },
          }),
        },
        USERS.tianjing.id,
      );

      expect(await listBlocksForDoc(blocksRepo, created.id)).toHaveLength(1);
      expect(await linksRepo.listBySource("doc", created.id)).toHaveLength(1);

      // Saving an empty root upgrades to one empty mega-block (CE-30) and
      // fully replaces prior refs; the block index keeps that single host block.
      await docs.saveDoc(created.id, { body: EMPTY_BODY }, USERS.tianjing.id);
      const clearedBlocks = await listBlocksForDoc(blocksRepo, created.id);
      expect(clearedBlocks).toHaveLength(1);
      expect(clearedBlocks[0]?.textSummary).toBeNull();
      expect(await linksRepo.listBySource("doc", created.id)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("rejects createDoc with duplicate blockIds as MegaBadRequestError, never a raw Drizzle/PG error", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));

      const duplicateBlockIdBody = JSON.stringify({
        root: {
          children: [
            { type: "mega-block", blockId: "3c72c69af7c6", variant: "text", children: [] },
            { type: "mega-block", blockId: "3c72c69af7c6", variant: "text", children: [] },
          ],
        },
      });

      await expect(
        docs.createDoc({ title: "Duplicate blockId doc", body: duplicateBlockIdBody }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
    } finally {
      await client.close();
    }
  });

  it("rejects illegal block payloads and oversized content on create/save (GC-11)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));

      await expect(
        docs.createDoc({ title: "Illegal doc", body: "{not json" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);

      await expect(
        docs.createDoc(
          {
            title: "Illegal block doc",
            body: JSON.stringify({ root: { children: [{ type: "mega-block", blockId: "", variant: "text", children: [] }] } }),
          },
          USERS.tianjing.id,
        ),
      ).rejects.toBeInstanceOf(MegaBadRequestError);

      const oversized = JSON.stringify({
        root: { children: [{ type: "mega-block", blockId: "blk_big_____", variant: "text", huge: "x".repeat(600_000), children: [] }] },
      });
      await expect(docs.createDoc({ title: "Oversized doc", body: oversized }, USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );

      const created = await docs.createDoc({ title: "Legit doc for save guard", body: EMPTY_BODY }, USERS.tianjing.id);
      await expect(
        docs.saveDoc(created.id, { body: "not json at all" }, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(docs.saveDoc(created.id, { title: "   " }, USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
      await expect(docs.saveDoc(created.id, { body: EMPTY_BODY, summary: "  " }, USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaBadRequestError,
      );
    } finally {
      await client.close();
    }
  });

  it("ACL gives signed-in workspace users read/write but keeps manage with owners", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
      const created = await docs.createDoc({ title: "ACL doc", body: EMPTY_BODY }, USERS.tianjing.id);

      await expect(docs.getDoc(created.id, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(docs.getDoc(created.id, USERS.rafael.id)).resolves.toMatchObject({ id: created.id });
      await expect(docs.saveDoc(created.id, { excerpt: "workspace write" }, USERS.rafael.id)).resolves.toMatchObject({ excerpt: "workspace write" });
      await expect(docs.deleteDoc(created.id, USERS.rafael.id)).rejects.toBeInstanceOf(MegaForbiddenError);
    } finally {
      await client.close();
    }
  });
});
