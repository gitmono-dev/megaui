// megaui:libs/mega/services/search.ts@0ff3a9d
//
// megaui-only implementation (EG-14, ADR-FS-01 §①.3/§④, split out of EG-10):
// CJK substring body search. `english.ts` (EG-10) never round-robins and
// never scans past the GIN index; this file is the opposite shape on
// purpose — SP-01's spike proved `to_tsvector('english'|'simple', ...)`
// treats a whole CJK sentence as one token (0 hits for a real substring
// query), so CJK recall here is a single-pass windowed
// `position(lower(query) in lower(text_summary))` scan (never `LIKE`/
// `ILIKE`, never the default-threshold `text_summary %` trigram operator —
// that measured 0 hits too, see ADR Appendix A.3), followed by an
// application-layer round-robin across `BODY_FTS_KINDS` so no requested
// kind is starved when `kinds.length * perKind > total` (GC-10). Rows
// above `SEARCH_CJK_MAX_BLOCKS` fail closed with `SearchCjkScaleExceededError`
// rather than let the scan degrade silently (ADR Consequences #3).
import { sql } from "drizzle-orm";
import { megaContentBlocks, type Database } from "@megaui/database";
import { SearchCjkScaleExceededError } from "../../errors";
import { applyLimits, computeFetchWindow, SEARCH_BODY_PER_KIND, SEARCH_BODY_TOTAL } from "./limits";
import {
  BODY_FTS_KINDS,
  isBodyFtsKind,
  type BodyFtsKind,
  type SearchBodyHit,
  type SearchBodyQuery,
} from "./types";

/**
 * Row-count ceiling above which the CJK `position()` full-table-scan path
 * fails closed (ADR-FS-01 §④/Consequences #3): `mega_content_blocks`
 * exceeding this means the scan is no longer proven to stay under the
 * 200ms P95 budget, and there is no CJK-indexable alternative in this repo
 * yet (zhparser/pg_jieba — DEP-01, not this card).
 */
export const SEARCH_CJK_MAX_BLOCKS = 200_000;

/**
 * CJK/Hangul/Kana script detector (Unicode block ranges, not a locale
 * library — this repo has no ICU dependency and doesn't need one for a
 * yes/no script check). Covers CJK Unified Ideographs (+ Extension A +
 * Compatibility Ideographs), Hiragana/Katakana, and Hangul syllables — the
 * scripts ADR-FS-01 §① found `to_tsvector('english'|'simple')` cannot
 * tokenize below whole-sentence granularity. Exported for the query-router
 * decision registered in ADR Consequences #2/#4 (which path a caller
 * chooses is that caller's decision — e.g. a future BFF route — this is
 * only the pure predicate it would need).
 */
const CJK_SCRIPT_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7a3]/u;

export function containsCjkScript(value: string): boolean {
  return CJK_SCRIPT_PATTERN.test(value);
}

function resolveKinds(kinds: SearchBodyQuery["kinds"]): BodyFtsKind[] {
  if (kinds === undefined) return [...BODY_FTS_KINDS];
  return kinds.filter(isBodyFtsKind);
}

/**
 * Fail-closed row-count guard (ADR Consequences #3). Runs on every call —
 * this is a request-time budget check, not a one-time startup check, so a
 * table that crosses the ceiling between two requests is caught on the
 * very next one.
 */
async function assertBelowScaleGuard(database: Database): Promise<void> {
  const rows = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(megaContentBlocks);
  const blockCount = rows[0]?.count ?? 0;
  if (blockCount > SEARCH_CJK_MAX_BLOCKS) {
    throw new SearchCjkScaleExceededError(blockCount, SEARCH_CJK_MAX_BLOCKS);
  }
}

/**
 * Deterministic round-robin over per-kind buckets, iterating `kinds` in
 * the caller's requested order and taking one hit from each kind per pass
 * (GC-10: no kind is fully drained before a later kind gets its first
 * item). `hitsByKind` values must already be in the window's `rn` order —
 * this function only interleaves, it never re-sorts within a kind.
 */
function roundRobinByKind(
  hitsByKind: ReadonlyMap<BodyFtsKind, SearchBodyHit[]>,
  kinds: readonly BodyFtsKind[],
): SearchBodyHit[] {
  const cursors = new Map<BodyFtsKind, number>(kinds.map((kind) => [kind, 0]));
  const result: SearchBodyHit[] = [];
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const kind of kinds) {
      const bucket = hitsByKind.get(kind);
      if (!bucket) continue;
      const cursor = cursors.get(kind) ?? 0;
      const hit = bucket[cursor];
      if (hit !== undefined) {
        result.push(hit);
        cursors.set(kind, cursor + 1);
        advanced = true;
      }
    }
  }
  return result;
}

interface CjkWindowRow extends Record<string, unknown> {
  source_type: string;
  source_id: string;
  block_id: string;
  text_summary: string | null;
  rn: number;
}

/**
 * CJK body search (ADR-FS-01 checklist items #7/#8/#14/#15/#16 — the EG-14
 * subset of the 18-item list; English's #1-#6/#9 are EG-10).
 *
 * - Empty query, or a `kinds` filter that resolves to zero known kinds,
 *   both short-circuit to `[]` with no query issued (mirrors English's
 *   checklist #1/#4 — no full-table scan is ever run for a query that
 *   would trivially have no results anyway).
 * - Fail-closed scale guard (checklist #15) runs before the substring scan.
 * - Production SQL (checklist #1/#7): a single windowed
 *   `SELECT source_type, source_id, block_id, text_summary, rn FROM (...
 *   row_number() OVER (PARTITION BY source_type ORDER BY source_id,
 *   block_id) AS rn ...) WHERE rn <= perKindFetch ORDER BY source_type,
 *   rn` — one Seq Scan, not `kinds.length` separate queries. The
 *   predicate is `position(lower(query) in lower(coalesce(text_summary,
 *   '')))  > 0` — literal substring, no `%`/`_` wildcard risk, and never
 *   the default-threshold `text_summary %` trigram operator (checklist
 *   #13, guarded by `cjk.test.ts`'s SQL-shape test).
 * - Application layer only ever round-robins here — never for English
 *   (checklist #6/#16's other half, enforced in `english.ts`).
 * - `rank` on every hit is `0`: CJK order comes from the round-robin
 *   position, not a relevance score — there is no CJK counterpart to
 *   `ts_rank`, so this is a documented constant rather than a fabricated
 *   number a caller might mistake for one.
 */
export async function searchCjk(
  database: Database,
  input: SearchBodyQuery,
): Promise<SearchBodyHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  const kinds = resolveKinds(input.kinds);
  if (kinds.length === 0) return [];

  const offset = Math.max(0, input.offset ?? 0);
  const total = Math.max(0, input.total ?? SEARCH_BODY_TOTAL);
  if (total === 0) return [];

  const perKind = Math.max(1, input.perKind ?? SEARCH_BODY_PER_KIND);

  await assertBelowScaleGuard(database);

  // ADR-FS-01 §④: `perKindFetch = min(500, max(perKind, (offset + perKind)
  // * FETCH_MULTIPLIER))` — exactly `computeFetchWindow`'s shape, sized by
  // `perKind` (not `total`) because the window partitions per kind.
  const perKindFetch = computeFetchWindow({ offset, limit: perKind });

  const kindsFragment = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );

  const result = await database.execute<CjkWindowRow>(sql`
    SELECT source_type, source_id, block_id, text_summary, rn
    FROM (
      SELECT
        ${megaContentBlocks.sourceType} AS source_type,
        ${megaContentBlocks.sourceId} AS source_id,
        ${megaContentBlocks.blockId} AS block_id,
        ${megaContentBlocks.textSummary} AS text_summary,
        row_number() OVER (
          PARTITION BY ${megaContentBlocks.sourceType}
          ORDER BY ${megaContentBlocks.sourceId}, ${megaContentBlocks.blockId}
        ) AS rn
      FROM ${megaContentBlocks}
      WHERE position(lower(${query}) in lower(coalesce(${megaContentBlocks.textSummary}, ''))) > 0
        AND ${megaContentBlocks.sourceType} = ANY(ARRAY[${kindsFragment}])
    ) AS windowed
    WHERE rn <= ${perKindFetch}
    ORDER BY source_type, rn
  `);

  const hitsByKind = new Map<BodyFtsKind, SearchBodyHit[]>();
  for (const row of result.rows) {
    if (!isBodyFtsKind(row.source_type)) continue; // defensive; ANY($kinds) already restricts this
    const bucket = hitsByKind.get(row.source_type) ?? [];
    bucket.push({
      sourceType: row.source_type,
      sourceId: row.source_id,
      blockId: row.block_id,
      textSummary: row.text_summary ?? "",
      rank: 0,
    });
    hitsByKind.set(row.source_type, bucket);
  }

  const roundRobinned = roundRobinByKind(hitsByKind, kinds);
  return applyLimits(roundRobinned, { offset, total });
}
