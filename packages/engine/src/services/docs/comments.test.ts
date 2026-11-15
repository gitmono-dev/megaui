import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseClient,
  megaContent,
  megaContentContainerTypes,
  megaDocCollaboratorRoles,
  megaDocCollaborators,
  megaDocComments,
} from "@megaui/database";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MegaBadRequestError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { createAclService } from "../acl";
import { createBlocksRepo } from "./blocks";
import { createDocsService } from "./docs";
import { createLinksRepo } from "./links";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] docs/comments.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] docs/comments.test.ts: DATABASE_URL is unset — skipping PG docs comments suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMPTY_BODY = '{"root":{"children":[]}}';

describe.skipIf(!adminDatabaseUrl)("docs comments list+create (DC-01, throwaway PG)", () => {
  const testDbName = `megaui_test_doc_comments_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  function createDocs() {
    const client = createDatabaseClient({ connectionString });
    const acl = createAclService(client.db);
    const docs = createDocsService(client.db, acl, createBlocksRepo(client.db), createLinksRepo(client.db));
    return { client, docs };
  }

  it("lists comments in createdAt order and returns [] when empty (new)", async () => {
    const { client, docs } = createDocs();
    try {
      const created = await docs.createDoc({ title: "Comments empty list", body: EMPTY_BODY }, USERS.tianjing.id);
      expect(await docs.listDocComments(created.id, USERS.tianjing.id)).toEqual([]);

      const first = await docs.addDocComment(created.id, "First comment", USERS.tianjing.id);
      await sleep(5);
      const second = await docs.addDocComment(created.id, "Second comment", USERS.tianjing.id);
      const listed = await docs.listDocComments(created.id, USERS.tianjing.id);
      expect(listed.map((comment) => comment.id)).toEqual([first.id, second.id]);
      expect(listed.map((comment) => comment.body)).toEqual(["First comment", "Second comment"]);
    } finally {
      await client.close();
    }
  });

  it("writes comment row and mega_content { text } in one transaction (new)", async () => {
    const { client, docs } = createDocs();
    try {
      const created = await docs.createDoc({ title: "Comments persist body", body: EMPTY_BODY }, USERS.tianjing.id);
      const added = await docs.addDocComment(created.id, "  Persisted body  ", USERS.tianjing.id);
      expect(added.body).toBe("Persisted body");
      expect(added.reactions).toEqual([]);

      const [commentRow] = await client.db
        .select({
          id: megaDocComments.id,
          docId: megaDocComments.docId,
          authorId: megaDocComments.authorId,
        })
        .from(megaDocComments)
        .where(eq(megaDocComments.id, added.id))
        .limit(1);
      expect(commentRow).toEqual({
        id: added.id,
        docId: created.id,
        authorId: USERS.tianjing.id,
      });

      const [content] = await client.db
        .select({ bodyJson: megaContent.bodyJson, bodyFormatVersion: megaContent.bodyFormatVersion })
        .from(megaContent)
        .where(
          and(
            eq(megaContent.containerType, megaContentContainerTypes.DOC_COMMENT),
            eq(megaContent.containerId, added.id),
          ),
        )
        .limit(1);
      expect(content?.bodyJson).toEqual({ text: "Persisted body" });
      expect(content?.bodyFormatVersion).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("derives getDoc.commentCount from COUNT after add (new)", async () => {
    const { client, docs } = createDocs();
    try {
      const created = await docs.createDoc({ title: "Comments count", body: EMPTY_BODY }, USERS.tianjing.id);
      expect((await docs.getDoc(created.id, USERS.tianjing.id)).commentCount).toBe(0);
      await docs.addDocComment(created.id, "One", USERS.tianjing.id);
      await docs.addDocComment(created.id, "Two", USERS.tianjing.id);
      expect((await docs.getDoc(created.id, USERS.tianjing.id)).commentCount).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("rejects empty or whitespace comment bodies (new)", async () => {
    const { client, docs } = createDocs();
    try {
      const created = await docs.createDoc({ title: "Comments empty body", body: EMPTY_BODY }, USERS.tianjing.id);
      await expect(docs.addDocComment(created.id, "", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaBadRequestError);
      await expect(docs.addDocComment(created.id, "   ", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaBadRequestError);
    } finally {
      await client.close();
    }
  });

  it("uses workspace read ACL and allows signed-in users to add comments", async () => {
    const { client, docs } = createDocs();
    try {
      const created = await docs.createDoc({ title: "Comments ACL", body: EMPTY_BODY }, USERS.tianjing.id);

      await expect(docs.listDocComments(created.id, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(docs.addDocComment(created.id, "nope", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      await expect(docs.listDocComments(created.id, USERS.rafael.id)).resolves.toEqual([]);
      const workspaceComment = await docs.addDocComment(created.id, "Workspace may discuss", USERS.rafael.id);
      expect(workspaceComment.author.id).toBe(USERS.rafael.id);
      await expect(docs.listDocComments("doc_missing", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaNotFoundError);
      await expect(docs.addDocComment("doc_missing", "nope", USERS.tianjing.id)).rejects.toBeInstanceOf(
        MegaNotFoundError,
      );

      await client.db.insert(megaDocCollaborators).values({
        id: `collab_${created.id}_${USERS.rafael.id}`,
        docId: created.id,
        userId: USERS.rafael.id,
        role: megaDocCollaboratorRoles.VIEWER,
      });
      const viewerComment = await docs.addDocComment(created.id, "Viewer may discuss", USERS.rafael.id);
      expect(viewerComment.author.id).toBe(USERS.rafael.id);
      expect((await docs.listDocComments(created.id, USERS.rafael.id)).map((comment) => comment.id)).toEqual([
        workspaceComment.id,
        viewerComment.id,
      ]);
    } finally {
      await client.close();
    }
  });
});
