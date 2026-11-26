// EG-10 (ADR-FS-01) — throwaway one-shot PG database, same harness shape as
// `packages/database/src/migrate.test.ts` / `docs/docs.test.ts`. NEVER runs
// `db:migrate` against a developer's real `DATABASE_URL`; it only ever
// creates+drops its own `megaui_test_search_english_*` database, using
// `DATABASE_URL` purely as the admin connection for `CREATE DATABASE`.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaContentBlocks, megaContentContainerTypes } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEARCH_BODY_TOTAL } from "./limits";
import { searchEnglish } from "./english";
import { rankByTitleScore, searchTextScore, SEARCH_TITLE_SCORE } from "./title";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] search/english.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] search/english.test.ts: DATABASE_URL is unset — skipping PG English search suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function contentBlockRow(overrides: {
  id: string;
  sourceType: string;
  sourceId: string;
  blockId: string;
  textSummary: string | null;
}) {
  const now = new Date();
  return {
    id: overrides.id,
    sourceType: overrides.sourceType,
    sourceId: overrides.sourceId,
    blockId: overrides.blockId,
    parentBlockId: null,
    depth: 0,
    variant: "paragraph",
    textSummary: overrides.textSummary,
    createdAt: now,
    updatedAt: now,
  };
}

describe.skipIf(!adminDatabaseUrl)("searchEnglish (EG-10, throwaway PG)", () => {
  const testDbName = `megaui_test_search_english_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: import("pg").Pool;
  let connectionString: string;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
    const migratePool = new Pool({ connectionString });
    try {
      await migrate((await import("drizzle-orm/node-postgres")).drizzle(migratePool), { migrationsFolder });
    } finally {
      await migratePool.end();
    }
  }, 30_000);

  afterAll(async () => {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  });

  // Every `it()` shares one migrated database (cheaper than a fresh
  // `CREATE DATABASE` per test) — clear the one table these tests touch so
  // an earlier test's rows can never leak into a later test's query.
  beforeEach(async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.delete(megaContentBlocks);
    } finally {
      await client.close();
    }
  });

  it("returns [] for an empty/blank query without issuing a query (AC #1)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await expect(searchEnglish(client.db, { query: "" })).resolves.toEqual([]);
      await expect(searchEnglish(client.db, { query: "   " })).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("hits the GIN index and ranks ts_rank descending (AC #4/#5, checklist #2)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        contentBlockRow({
          id: "blk_rank_low",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_rank_low",
          blockId: "b1",
          textSummary: "A brief note that touches on postgres migration once.",
        }),
        contentBlockRow({
          id: "blk_rank_high",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_rank_high",
          blockId: "b1",
          textSummary: "Postgres migration postgres migration: a deep dive into postgres migration tooling.",
        }),
      ]);

      const hits = await searchEnglish(client.db, { query: "postgres migration" });
      expect(hits.map((hit) => hit.sourceId)).toEqual(["doc_rank_high", "doc_rank_low"]);
      const [high, low] = hits;
      if (!high || !low) throw new Error("unreachable: length asserted above");
      expect(high.rank).toBeGreaterThan(low.rank);
      expect(hits.every((hit) => hit.rank > 0)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("matches English stems across word forms (checklist #3)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        contentBlockRow({
          id: "blk_stem_1",
          sourceType: megaContentContainerTypes.ISSUE,
          sourceId: "issue_1",
          blockId: "b1",
          textSummary: "Fix the user authentication flow before release.",
        }),
        contentBlockRow({
          id: "blk_stem_2",
          sourceType: megaContentContainerTypes.CL,
          sourceId: "cl_1",
          blockId: "b1",
          textSummary: "This CL is migrating the legacy login service.",
        }),
      ]);

      const authHits = await searchEnglish(client.db, { query: "authenticate" });
      expect(authHits.map((hit) => hit.sourceId)).toEqual(["issue_1"]);

      const migrateHits = await searchEnglish(client.db, { query: "migration" });
      expect(migrateHits.map((hit) => hit.sourceId)).toEqual(["cl_1"]);
    } finally {
      await client.close();
    }
  });

  it("filters by kinds, and an explicit empty kinds list yields no hits (AC #4)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        contentBlockRow({
          id: "blk_kind_doc",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_kind",
          blockId: "b1",
          textSummary: "Widget catalog overview for the workspace.",
        }),
        contentBlockRow({
          id: "blk_kind_chat",
          sourceType: megaContentContainerTypes.CHAT_MESSAGE,
          sourceId: "msg_kind",
          blockId: "b1",
          textSummary: "Widget catalog discussion in general channel.",
        }),
      ]);

      const docOnly = await searchEnglish(client.db, { query: "widget catalog", kinds: [megaContentContainerTypes.DOC] });
      expect(docOnly.map((hit) => hit.sourceType)).toEqual([megaContentContainerTypes.DOC]);

      const noKinds = await searchEnglish(client.db, { query: "widget catalog", kinds: [] });
      expect(noKinds).toEqual([]);

      const unknownKindsOnly = await searchEnglish(client.db, {
        query: "widget catalog",
        kinds: ["channel", "release"],
      });
      expect(unknownKindsOnly).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("caps results at SEARCH_BODY_TOTAL by default and supports offset paging without reordering (checklist #5/#16)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const rowCount = 35;
      // Descending repetition count -> strictly descending ts_rank, so
      // insertion order is the expected rank order (row 0 highest).
      await client.db.insert(megaContentBlocks).values(
        Array.from({ length: rowCount }, (_, index) => {
          const repeats = rowCount - index;
          return contentBlockRow({
            id: `blk_paging_${index}`,
            sourceType: megaContentContainerTypes.DOC,
            sourceId: `doc_paging_${index}`,
            blockId: "b1",
            textSummary: Array.from({ length: repeats }, () => "gadget").join(" "),
          });
        }),
      );

      const defaultPage = await searchEnglish(client.db, { query: "gadget" });
      expect(defaultPage).toHaveLength(SEARCH_BODY_TOTAL);
      expect(defaultPage.map((hit) => hit.sourceId)).toEqual(
        Array.from({ length: SEARCH_BODY_TOTAL }, (_, index) => `doc_paging_${index}`),
      );
      for (let i = 1; i < defaultPage.length; i += 1) {
        const prev = defaultPage[i - 1];
        const curr = defaultPage[i];
        if (!prev || !curr) throw new Error("unreachable: index within defaultPage.length");
        expect(prev.rank).toBeGreaterThanOrEqual(curr.rank);
      }

      const secondPage = await searchEnglish(client.db, { query: "gadget", offset: SEARCH_BODY_TOTAL, total: 10 });
      expect(secondPage.map((hit) => hit.sourceId)).toEqual(
        Array.from({ length: rowCount - SEARCH_BODY_TOTAL }, (_, index) => `doc_paging_${SEARCH_BODY_TOTAL + index}`),
      );
    } finally {
      await client.close();
    }
  });

  it("never round-robins across kinds — a higher-rank hit in a later kind still sorts first (checklist #6/#16)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        contentBlockRow({
          id: "blk_rr_doc",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_rr",
          blockId: "b1",
          textSummary: "sprocket once in this doc.",
        }),
        contentBlockRow({
          id: "blk_rr_chat",
          sourceType: megaContentContainerTypes.CHAT_MESSAGE,
          sourceId: "msg_rr",
          blockId: "b1",
          textSummary: "sprocket sprocket sprocket sprocket in this chat message.",
        }),
      ]);

      const hits = await searchEnglish(client.db, { query: "sprocket" });
      // If this were round-robinned by kind, "doc" (first in BODY_FTS_KINDS)
      // would be forced ahead of a later kind regardless of rank.
      expect(hits.map((hit) => hit.sourceType)).toEqual([
        megaContentContainerTypes.CHAT_MESSAGE,
        megaContentContainerTypes.DOC,
      ]);
    } finally {
      await client.close();
    }
  });

  it("completes an English production-shape query well under the 200ms P95 budget (ADR-FS-01 §④)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const kinds = Object.values(megaContentContainerTypes);
      await client.db.insert(megaContentBlocks).values(
        Array.from({ length: 300 }, (_, index) => {
          const kind = kinds[index % kinds.length] ?? megaContentContainerTypes.DOC;
          return contentBlockRow({
            id: `blk_perf_${index}`,
            sourceType: kind,
            sourceId: `perf_${index}`,
            blockId: "b1",
            textSummary:
              index % 7 === 0
                ? "Investigating a postgres migration rollback plan for the workspace."
                : "Unrelated filler content about the weekly planning sync.",
          });
        }),
      );

      const startedAt = performance.now();
      const hits = await searchEnglish(client.db, { query: "postgres migration" });
      const elapsedMs = performance.now() - startedAt;

      expect(hits.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(200);
    } finally {
      await client.close();
    }
  });
});

describe("english.ts production SQL guard (checklist #6: no LIKE)", () => {
  it("never uses LIKE/ILIKE in the English body-search query", () => {
    const source = fs.readFileSync(path.resolve(dirname, "english.ts"), "utf8");
    // Strip comments first — this file's own doc comments *name* LIKE/ILIKE
    // to say they're forbidden; the guard only cares about executable code.
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/\bI?LIKE\b/i);
  });
});

describe("searchTextScore (title group, ADR-FS-01 §③ — still used, not tsvector)", () => {
  it("ranks exact < prefix < word-boundary < substring, lower is better", () => {
    expect(searchTextScore("auth", "auth")).toBe(SEARCH_TITLE_SCORE.EXACT);
    expect(searchTextScore("auth", "authentication service")).toBe(SEARCH_TITLE_SCORE.PREFIX);
    expect(searchTextScore("auth", "user auth flow")).toBe(SEARCH_TITLE_SCORE.WORD_BOUNDARY);
    expect(searchTextScore("auth", "oauth flow")).toBe(SEARCH_TITLE_SCORE.SUBSTRING);
    expect(searchTextScore("auth", "totally unrelated")).toBeNull();
  });

  it("is case-insensitive and trims the query", () => {
    expect(searchTextScore("  Auth  ", "AUTH")).toBe(SEARCH_TITLE_SCORE.EXACT);
  });

  it("returns null for an empty/blank query", () => {
    expect(searchTextScore("", "anything")).toBeNull();
    expect(searchTextScore("   ", "anything")).toBeNull();
  });

  it("rankByTitleScore orders best-match-first and drops non-matches", () => {
    const items = [
      { id: "1", title: "oauth flow" },
      { id: "2", title: "auth" },
      { id: "3", title: "user auth flow" },
      { id: "4", title: "unrelated" },
      { id: "5", title: "authentication service" },
    ];
    const ranked = rankByTitleScore("auth", items);
    expect(ranked.map((hit) => hit.item.id)).toEqual(["2", "5", "3", "1"]);
    const cl = { id: "cl-1", title: "unrelated", publicId: "cl0420testID" };
    expect(rankByTitleScore(cl.publicId, [...items, cl])).toEqual([{ item: cl, score: SEARCH_TITLE_SCORE.EXACT }]);
    const legacy = "cl_42-testID";
    const titleHit = { id: "cl-2", title: `${legacy} details` };
    expect(rankByTitleScore(legacy, [titleHit, cl], cl.publicId)).toEqual([
      { item: cl, score: SEARCH_TITLE_SCORE.EXACT },
      { item: titleHit, score: SEARCH_TITLE_SCORE.PREFIX },
    ]);
  });
});
