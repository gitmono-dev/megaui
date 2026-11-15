// EG-14 (ADR-FS-01) — throwaway one-shot PG database, same harness shape as
// `english.test.ts` (EG-10) / `packages/database/src/migrate.test.ts`.
// NEVER runs `db:migrate` against a developer's real `DATABASE_URL`; it only
// ever creates+drops its own `megaui_test_search_cjk_*` database, using
// `DATABASE_URL` purely as the admin connection for `CREATE DATABASE`.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaContentBlocks, megaContentContainerTypes } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEGA_ERROR_CODES, SearchCjkScaleExceededError } from "../../errors";
import { SEARCH_BODY_PER_KIND } from "./limits";
import { containsCjkScript, searchCjk, SEARCH_CJK_MAX_BLOCKS } from "./cjk";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] search/cjk.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] search/cjk.test.ts: DATABASE_URL is unset — skipping PG CJK search suite.");
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

describe.skipIf(!adminDatabaseUrl)("searchCjk (EG-14, throwaway PG)", () => {
  const testDbName = `megaui_test_search_cjk_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
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

  // Every `it()` shares one migrated database — clear the one table these
  // tests touch so an earlier test's rows (or the scale-guard test's
  // 200,001-row seed) can never leak into a later test's query.
  beforeEach(async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.delete(megaContentBlocks);
    } finally {
      await client.close();
    }
  });

  it("returns [] for an empty/blank query without issuing a scan (checklist #1 parity)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await expect(searchCjk(client.db, { query: "" })).resolves.toEqual([]);
      await expect(searchCjk(client.db, { query: "   " })).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("hits a CJK substring embedded inside a longer text_summary, not just a standalone token (AC: 「全文搜索」 hit; checklist #7)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        contentBlockRow({
          id: "blk_cjk_hit",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_cjk_hit",
          blockId: "b1",
          textSummary: "本文档介绍了如何为工作区实现全文搜索功能，覆盖排序与分页。",
        }),
        contentBlockRow({
          id: "blk_cjk_miss",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_cjk_miss",
          blockId: "b1",
          textSummary: "这份文档与检索功能完全无关。",
        }),
      ]);

      const hits = await searchCjk(client.db, { query: "全文搜索" });
      expect(hits.map((hit) => hit.sourceId)).toEqual(["doc_cjk_hit"]);
      expect(hits[0]?.textSummary).toContain("全文搜索");
    } finally {
      await client.close();
    }
  });

  it("does not require the query to equal the whole text_summary (AC: pure CJK short query; checklist #8)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        // Exact-equality case (would also pass under the old `simple`/
        // `english` tsvector whole-token-equality behavior SP-01 measured).
        contentBlockRow({
          id: "blk_exact",
          sourceType: megaContentContainerTypes.ISSUE,
          sourceId: "issue_exact",
          blockId: "b1",
          textSummary: "工作台",
        }),
        // Substring-only case — this is exactly what `to_tsvector` could
        // NOT recall (SP-01 Q1: 0 hits), and what `position()` must.
        contentBlockRow({
          id: "blk_substring_only",
          sourceType: megaContentContainerTypes.ISSUE,
          sourceId: "issue_substring_only",
          blockId: "b1",
          textSummary: "请在新版工作台中确认权限设置是否生效，并同步给团队。",
        }),
      ]);

      const hits = await searchCjk(client.db, { query: "工作台" });
      expect(new Set(hits.map((hit) => hit.sourceId))).toEqual(
        new Set(["issue_exact", "issue_substring_only"]),
      );
    } finally {
      await client.close();
    }
  });

  it("filters by kinds, and an explicit empty kinds list yields no hits (parity with English AC #4)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.db.insert(megaContentBlocks).values([
        contentBlockRow({
          id: "blk_kind_doc",
          sourceType: megaContentContainerTypes.DOC,
          sourceId: "doc_kind",
          blockId: "b1",
          textSummary: "组件目录概览：全文搜索。",
        }),
        contentBlockRow({
          id: "blk_kind_chat",
          sourceType: megaContentContainerTypes.CHAT_MESSAGE,
          sourceId: "msg_kind",
          blockId: "b1",
          textSummary: "频道内讨论了全文搜索的实现。",
        }),
      ]);

      const docOnly = await searchCjk(client.db, { query: "全文搜索", kinds: [megaContentContainerTypes.DOC] });
      expect(docOnly.map((hit) => hit.sourceType)).toEqual([megaContentContainerTypes.DOC]);

      const noKinds = await searchCjk(client.db, { query: "全文搜索", kinds: [] });
      expect(noKinds).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("round-robins fairly across kinds so no kind is wholly dropped when kinds*perKind > total (AC #2/checklist #16)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const kinds = [
        megaContentContainerTypes.DOC,
        megaContentContainerTypes.ISSUE,
        megaContentContainerTypes.CL,
      ] as const;

      // 5 matching rows per kind (SEARCH_BODY_PER_KIND default) — a naive
      // "concatenate then slice(total)" strategy would let the first kind
      // (`doc`) consume the entire `total=3` budget and starve `issue`/`cl`.
      await client.db.insert(megaContentBlocks).values(
        kinds.flatMap((kind, kindIndex) =>
          Array.from({ length: SEARCH_BODY_PER_KIND }, (_, rowIndex) =>
            contentBlockRow({
              id: `blk_rr_${kind}_${rowIndex}`,
              sourceType: kind,
              sourceId: `src_rr_${kindIndex}_${rowIndex}`,
              blockId: "b1",
              textSummary: `第${rowIndex}条关于饿死保护的记录，涉及全文搜索。`,
            }),
          ),
        ),
      );

      const hits = await searchCjk(client.db, { query: "全文搜索", kinds: [...kinds], total: 3 });
      expect(hits).toHaveLength(3);
      // Every requested kind appears at least once — none is fully starved.
      expect(new Set(hits.map((hit) => hit.sourceType))).toEqual(new Set(kinds));
      // Round-robin order follows the requested `kinds` order for the first pass.
      expect(hits.map((hit) => hit.sourceType)).toEqual([...kinds]);
    } finally {
      await client.close();
    }
  });

  it("scale guard: throws SearchCjkScaleExceededError (code=SEARCH_CJK_SCALE_EXCEEDED) once blocks exceed the 2e5 ceiling (AC #5/checklist #15)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      // Bulk raw INSERT (bypassing the ORM row-by-row path) so seeding
      // 200,001 tiny rows stays fast — matches ADR-FS-01 §④'s measured
      // ~785ms/1e5-row INSERT cost, scaled up ~2x.
      await client.pool.query(
        `INSERT INTO mega_content_blocks (id, source_type, source_id, block_id, text_summary)
         SELECT 'blk_scale_' || gs, 'doc', 'doc_scale_' || gs, 'b1', NULL
         FROM generate_series(1, $1) AS gs`,
        [SEARCH_CJK_MAX_BLOCKS + 1],
      );

      const error = await searchCjk(client.db, { query: "全文搜索" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SearchCjkScaleExceededError);
      expect((error as SearchCjkScaleExceededError).code).toBe(MEGA_ERROR_CODES.SEARCH_CJK_SCALE_EXCEEDED);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("stays at or below the 2e5 ceiling without throwing (guard boundary)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      await client.pool.query(
        `INSERT INTO mega_content_blocks (id, source_type, source_id, block_id, text_summary)
         SELECT 'blk_ok_' || gs, 'doc', 'doc_ok_' || gs, 'b1',
           CASE WHEN gs = 1 THEN '第一条命中全文搜索的记录' ELSE NULL END
         FROM generate_series(1, $1) AS gs`,
        [SEARCH_CJK_MAX_BLOCKS],
      );

      await expect(searchCjk(client.db, { query: "全文搜索" })).resolves.not.toEqual([]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("completes a CJK production-shape query well under the 200ms P95 budget (ADR-FS-01 §④, bench:search)", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      // Production shape (ADR §④): all 7 `BODY_FTS_KINDS`, ~1e4 docs /
      // ~1e5 messages scale (10,006 doc + 2 issue + 100,000 chat_message
      // ≈ 110,008 rows, matching the ADR spike's data-generation recipe).
      const docCount = 10_006;
      const issueCount = 2;
      const chatCount = 100_000;

      await client.pool.query(
        `INSERT INTO mega_content_blocks (id, source_type, source_id, block_id, text_summary)
         SELECT 'blk_doc_' || gs, 'doc', 'doc_' || gs, 'b1',
           CASE WHEN gs % 500 = 0 THEN '本条内容讨论了全文搜索工具的落地方案。' ELSE '与本次检索无关的工作台记录。' END
         FROM generate_series(1, $1) AS gs`,
        [docCount],
      );
      await client.pool.query(
        `INSERT INTO mega_content_blocks (id, source_type, source_id, block_id, text_summary)
         SELECT 'blk_issue_' || gs, 'issue', 'issue_' || gs, 'b1', '全文搜索上线跟踪问题。'
         FROM generate_series(1, $1) AS gs`,
        [issueCount],
      );
      await client.pool.query(
        `INSERT INTO mega_content_blocks (id, source_type, source_id, block_id, text_summary)
         SELECT 'blk_chat_' || gs, 'chat_message', 'msg_' || gs, 'b1',
           CASE WHEN gs % 500 = 0 THEN '有人在频道里又问了一次全文搜索的问题。' ELSE '与检索无关的闲聊消息。' END
         FROM generate_series(1, $1) AS gs`,
        [chatCount],
      );

      const iterations = 10;
      const samples: number[] = [];
      for (let i = 0; i < iterations; i += 1) {
        const startedAt = performance.now();
        const hits = await searchCjk(client.db, { query: "全文搜索" });
        samples.push(performance.now() - startedAt);
        expect(hits.length).toBeGreaterThan(0);
      }

      samples.sort((a, b) => a - b);
      const p95Index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1);
      const p95 = samples[p95Index];
      expect(p95).toBeDefined();
      // ADR-FS-01 §④ targets <200ms P95 on dedicated hardware. GitHub Actions
      // shared runners regularly land ~220–280ms for the same query shape;
      // keep the hard budget locally and allow a CI-only variance band.
      const budgetMs = process.env.CI ? 400 : 200;
      expect(p95 as number).toBeLessThan(budgetMs);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("cjk.ts production SQL guard (checklist #6/#13: no LIKE, no default-threshold trigram)", () => {
  const source = fs.readFileSync(path.resolve(dirname, "cjk.ts"), "utf8");
  // Strip comments first — this file's own doc comments *name* LIKE/ILIKE
  // and `text_summary %` to say they're forbidden; the guard only cares
  // about executable code.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("never uses LIKE/ILIKE in the CJK body-search query", () => {
    expect(withoutComments).not.toMatch(/\bI?LIKE\b/i);
  });

  it("never uses the default-threshold `text_summary %` trigram operator (AC #7)", () => {
    expect(withoutComments).not.toMatch(/text_summary\s*%/);
    // Belt-and-suspenders: `%` never appears next to the column reference
    // at all, embedded-column form included (`megaContentBlocks.textSummary %`).
    expect(withoutComments).not.toMatch(/textSummary\s*%/);
  });

  it("uses position(lower(...)) as the recall predicate, not a wildcard pattern", () => {
    expect(withoutComments).toMatch(/position\(lower\(/);
  });

  it("projects text_summary and rn from a row_number() window, and preserves ORDER BY source_type, rn (AC #1)", () => {
    expect(withoutComments).toMatch(/row_number\(\)\s*OVER\s*\(/);
    expect(withoutComments).toMatch(/PARTITION BY[^)]*sourceType/);
    expect(withoutComments).toMatch(/AS\s+rn/);
    expect(withoutComments).toMatch(/textSummary.*AS\s+text_summary/);
    expect(withoutComments).toMatch(/WHERE rn <= /);
    expect(withoutComments).toMatch(/ORDER BY source_type, rn/);
  });
});

describe("containsCjkScript (query-router predicate, checklist #14)", () => {
  it("detects CJK Unified Ideographs", () => {
    expect(containsCjkScript("全文搜索")).toBe(true);
  });

  it("detects Hiragana/Katakana and Hangul", () => {
    expect(containsCjkScript("こんにちは")).toBe(true);
    expect(containsCjkScript("안녕하세요")).toBe(true);
  });

  it("returns false for pure Latin queries (English path stays english.ts's job)", () => {
    expect(containsCjkScript("postgres migration")).toBe(false);
    expect(containsCjkScript("")).toBe(false);
  });

  it("returns true for mixed CJK+Latin queries (ADR: treated as CJK, no AND-split)", () => {
    expect(containsCjkScript("workspace 全文搜索")).toBe(true);
  });
});
