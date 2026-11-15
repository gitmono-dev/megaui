// megaui:libs/mega/services/search.ts@0ff3a9d
//
// megaui-only reimplementation (EG-10, ADR-FS-01 §②/§③): PG English
// full-text search over `mega_content_blocks.text_search` (GENERATED
// tsvector + GIN index, `drizzle/0002_body_fts.sql`) — not vendored from
// the file above (see `title.ts`'s header for why), only its documented
// behavior. CJK substring recall (window + round-robin +
// `SearchCjkScaleExceededError`) is EG-14 — this file only ever runs the
// English `plainto_tsquery` + `ts_rank` branch described there.
//
// `text_search` has no Drizzle column (see `mega-content.ts`'s
// `megaContentBlocks` comment), so the `text_search`/`ts_rank` expressions
// below are raw `sql` fragments — there is no typed query-builder path to
// a generated column — mixed into an otherwise ordinary `select().from()`
// call so `source_type` filtering still gets the typed `inArray` helper.
import { and, desc, inArray, sql } from "drizzle-orm";
import { megaContentBlocks, type Database } from "@megaui/database";
import { applyLimits, computeFetchWindow, SEARCH_BODY_TOTAL } from "./limits";
import {
  BODY_FTS_KINDS,
  isBodyFtsKind,
  type BodyFtsKind,
  type SearchBodyHit,
  type SearchBodyQuery,
} from "./types";

function resolveKinds(kinds: SearchBodyQuery["kinds"]): BodyFtsKind[] {
  if (kinds === undefined) return [...BODY_FTS_KINDS];
  return kinds.filter(isBodyFtsKind);
}

/**
 * English body search (ADR-FS-01 checklist items #2/#3/#4/#5/#6/#9, the
 * EG-10 subset of the 18-item list; CJK items #7/#8/#14/#15/#16 are EG-14).
 *
 * - Empty query, or a `kinds` filter that resolves to zero known kinds,
 *   both short-circuit to `[]` with no query issued (checklist #1/#4).
 * - Production SQL (checklist #6): `plainto_tsquery('english', ...)`
 *   against the GIN-indexed `text_search` column — no `LIKE`/`ILIKE`
 *   anywhere in this file.
 * - `ORDER BY rank DESC` only; results are never round-robinned across
 *   kinds (checklist #6's English half + Consequences #2's prohibition).
 * - `ts_rank` is exposed as-is: positive, higher = more relevant, sorted
 *   descending (checklist #2). This repo has no SQLite dialect to align a
 *   "lower is better" sign convention with (ADR-ARCH-02 is PG-only), so
 *   there is no counterpart value to negate against — the natural PG
 *   convention is kept and documented here rather than inverted.
 */
export async function searchEnglish(
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

  const fetchWindow = computeFetchWindow({ offset, limit: total });

  // `text_search`/`ts_rank` reference the generated column directly by name
  // (raw `sql`, unavoidable — it has no Drizzle column) inside an otherwise
  // ordinary query-builder call, so `source_type` filtering can use the
  // normal typed `inArray` helper instead of hand-rolling `= ANY($n)`
  // parameter binding (which drizzle's `sql` template spreads as one bind
  // param per array element, not a single array-typed param).
  const rankExpr = sql<number>`ts_rank(text_search, plainto_tsquery('english', ${query}))`;

  const rows = await database
    .select({
      sourceType: megaContentBlocks.sourceType,
      sourceId: megaContentBlocks.sourceId,
      blockId: megaContentBlocks.blockId,
      textSummary: megaContentBlocks.textSummary,
      rank: rankExpr,
    })
    .from(megaContentBlocks)
    .where(
      and(
        sql`text_search @@ plainto_tsquery('english', ${query})`,
        inArray(megaContentBlocks.sourceType, kinds),
      ),
    )
    .orderBy(desc(rankExpr))
    .limit(fetchWindow);

  const hits: SearchBodyHit[] = rows.map((row) => ({
    sourceType: row.sourceType as BodyFtsKind,
    sourceId: row.sourceId,
    blockId: row.blockId,
    textSummary: row.textSummary ?? "",
    rank: Number(row.rank),
  }));

  return applyLimits(hits, { offset, total });
}
