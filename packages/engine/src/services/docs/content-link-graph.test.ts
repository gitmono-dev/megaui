import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseClient,
  megaCls,
  megaClPublicIds,
  megaClCiStatuses,
  megaClMergeStates,
  megaClStates,
  megaIssuePriorities,
  megaIssues,
  megaIssueStates,
} from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../../seed";
import { SAMPLE_DOC, USERS } from "../../testing/fixtures";
import { createAclService } from "../acl";
import { createBlocksRepo } from "./blocks";
import { getContentLinkGraph } from "./content-link-graph";
import { createDocsService } from "./docs";
import { createLinksRepo, rebuildDocLinks } from "./links";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] docs/content-link-graph.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn(
    "[@megaui/engine] docs/content-link-graph.test.ts: DATABASE_URL is unset — skipping PG graph suite.",
  );
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("getContentLinkGraph (EG-03, throwaway PG)", () => {
  const testDbName = `megaui_test_graph_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  it("builds nodes for the full doc/issue/CL catalog and wikilink/embed edges", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      await client.db.insert(megaIssues).values({
        id: "issue_graph",
        number: 101,
        title: "Graph issue",
        state: megaIssueStates.OPEN,
        priority: megaIssuePriorities.P2,
        packageId: "pkg_engine",
        authorId: USERS.tianjing.id,
      });
      await client.db.insert(megaCls).values({
        id: "cl_graph",
        number: 202,
        title: "Graph CL",
        state: megaClStates.WIP,
        packageId: "pkg_engine",
        authorId: USERS.tianjing.id,
        ci: megaClCiStatuses.QUEUED,
        merge: megaClMergeStates.NEEDS_REVIEW,
      });

      const publicId = "GraphTXv02Qa";
      const legacyPublicId = "GraphTX-02_a";
      const underscorePublicId = "GraphTX_02_a";
      await client.db.insert(megaClPublicIds).values({ number: 202, publicId, legacyPublicId, underscorePublicId });
      const wikilinker = await docs.createDoc(
        {
          title: "Wikilinker",
          body: JSON.stringify({
            root: {
              children: [
                {
                  type: "mega-block",
                  blockId: "blk_wl______",
                  variant: "text",
                  children: [
                    { type: "mega-ref", ref: { kind: "doc", targetTitle: SAMPLE_DOC.title, targetId: SAMPLE_DOC.id } },
                    { type: "mega-ref", ref: { kind: "issue", targetTitle: "Graph issue", targetId: "101" } },
                    { type: "mega-ref", ref: { kind: "cl", targetTitle: "Graph CL", targetId: legacyPublicId } },
                  ],
                },
              ],
            },
          }),
        },
        USERS.tianjing.id,
      );

      const embedder = await docs.createDoc(
        {
          title: "Embedder",
          body: JSON.stringify({
            root: {
              children: [
                {
                  type: "mega-block",
                  blockId: "blk_embed___",
                  variant: "text",
                  children: [
                    { type: "mega-embed", embed: { targetDocId: SAMPLE_DOC.id } },
                    { type: "mega-ref", ref: { kind: "cl", targetTitle: "Graph CL", targetId: underscorePublicId } },
                  ],
                },
              ],
            },
          }),
        },
        USERS.tianjing.id,
      );

      const numericReference = await docs.createDoc({
        title: "Numeric reference",
        body: JSON.stringify({ root: { children: [{
          type: "mega-block", blockId: "numericRef42", variant: "text", children: [
            { type: "mega-ref", ref: { kind: "cl", targetTitle: "Graph CL", targetId: "202" } },
          ],
        }] } }),
      }, USERS.tianjing.id);

      const graph = await getContentLinkGraph(client.db, acl, USERS.tianjing.id);

      const nodeIds = graph.nodes.map((node) => node.id);
      expect(nodeIds).toContain(`doc:${SAMPLE_DOC.id}`);
      expect(nodeIds).toContain(`doc:${wikilinker.id}`);
      expect(nodeIds).toContain(`doc:${embedder.id}`);
      expect(nodeIds).toContain("issue:101");
      expect(graph.nodes).toContainEqual(expect.objectContaining({
        id: `cl:${publicId}`, entityId: publicId, href: `/cls/${publicId}`,
      }));
      expect(graph.edges.filter(edge =>
        edge.sourceNodeId === `doc:${wikilinker.id}` && edge.targetNodeId === `cl:${publicId}`
      )).toHaveLength(1);
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceNodeId: `doc:${embedder.id}`, targetNodeId: `cl:${publicId}`,
      }));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceNodeId: `doc:${numericReference.id}`, targetNodeId: `cl:${publicId}`,
      }));

      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: "wikilink",
          sourceNodeId: `doc:${wikilinker.id}`,
          targetNodeId: `doc:${SAMPLE_DOC.id}`,
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: "wikilink",
          sourceNodeId: `doc:${wikilinker.id}`,
          targetNodeId: "issue:101",
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: "embed",
          sourceNodeId: `doc:${embedder.id}`,
          targetNodeId: `doc:${SAMPLE_DOC.id}`,
        }),
      );
    } finally {
      await client.close();
    }
  });

  it("includes workspace doc nodes and edges for signed-in actors", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const linksRepo = createLinksRepo(client.db);

      const privateDocId = "doc_private_graph";
      const now = new Date();
      const { megaDocs, megaDocStatus } = await import("@megaui/database");
      await client.db.insert(megaDocs).values({
        id: privateDocId,
        title: "Private graph doc",
        authorId: USERS.eleanor.id,
        status: megaDocStatus.DRAFT,
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await rebuildDocLinks(
        linksRepo,
        privateDocId,
        JSON.stringify({
          root: {
            children: [
              { type: "mega-ref", ref: { kind: "doc", targetTitle: SAMPLE_DOC.title, targetId: SAMPLE_DOC.id } },
            ],
          },
        }),
      );

      const ownerGraph = await getContentLinkGraph(client.db, acl, USERS.eleanor.id);
      expect(ownerGraph.nodes.map((n) => n.id)).toContain(`doc:${privateDocId}`);

      const strangerGraph = await getContentLinkGraph(client.db, acl, USERS.rafael.id);
      expect(strangerGraph.nodes.map((n) => n.id)).toContain(`doc:${privateDocId}`);
      expect(
        strangerGraph.edges.some((edge) => edge.sourceNodeId === `doc:${privateDocId}`),
      ).toBe(true);

      const anonymousGraph = await getContentLinkGraph(client.db, acl, null);
      expect(anonymousGraph.nodes.some((n) => n.kind === "doc")).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("resolves block-target wikilinks to their owning doc node", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      const blocksRepo = createBlocksRepo(client.db);
      const linksRepo = createLinksRepo(client.db);
      const docs = createDocsService(client.db, acl, blocksRepo, linksRepo);

      const targetDoc = await docs.createDoc(
        {
          title: "Block target doc",
          body: JSON.stringify({
            root: {
              children: [{ type: "mega-block", blockId: "103177d17839", variant: "text", children: [{ type: "text", text: "Target" }] }],
            },
          }),
        },
        USERS.tianjing.id,
      );

      const sourceDoc = await docs.createDoc(
        {
          title: "Block ref source",
          body: JSON.stringify({
            root: {
              children: [
                {
                  type: "mega-block",
                  blockId: "9951e63010a9",
                  variant: "text",
                  children: [
                    {
                      type: "mega-block-ref",
                      blockRef: { targetDocId: targetDoc.id, targetBlockId: "103177d17839", label: "Target" },
                    },
                  ],
                },
              ],
            },
          }),
        },
        USERS.tianjing.id,
      );

      const graph = await getContentLinkGraph(client.db, acl, USERS.tianjing.id);
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: "wikilink",
          sourceNodeId: `doc:${sourceDoc.id}`,
          targetNodeId: `doc:${targetDoc.id}`,
        }),
      );
    } finally {
      await client.close();
    }
  });
});
