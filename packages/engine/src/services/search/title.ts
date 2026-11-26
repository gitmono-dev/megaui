// megaui:libs/mega/services/search.ts@0ff3a9d
//
// megaui-only reimplementation (EG-10, ADR-FS-01 §③): title/number-group
// ranking for the ⌘K-style search surface. Reimplemented from the ADR's
// behavior spec — REF-05 `searchTextScore` is not vendored into this repo,
// only its documented rank order (exact < prefix
// < word-boundary < substring, lower is better). This is intentionally
// separate from `@megaui/core`'s `searchTitleIndex` (a plain substring
// filter for `[[wikilink]]` autocomplete, CE-42) — the title *search group*
// needs the graded ranking this file provides, not just a filter.
//
// Body FTS (english.ts) never applies this scoring — ADR-FS-01 §③: no
// `setweight` title>body inside `text_search`; title stays app-layer.

/** Lower is better. `EXACT` beats `PREFIX` beats `WORD_BOUNDARY` beats `SUBSTRING`. */
export const SEARCH_TITLE_SCORE = {
  EXACT: 0,
  PREFIX: 1,
  WORD_BOUNDARY: 2,
  SUBSTRING: 3,
} as const;

export type SearchTitleScore = (typeof SEARCH_TITLE_SCORE)[keyof typeof SEARCH_TITLE_SCORE];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score how well `text` matches `query` for the title/number search group.
 * Lower is better; `null` means no match at all (ADR-FS-01 §③).
 */
export function searchTextScore(query: string, text: string): SearchTitleScore | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const haystack = text.toLowerCase();

  if (haystack === needle) return SEARCH_TITLE_SCORE.EXACT;
  if (haystack.startsWith(needle)) return SEARCH_TITLE_SCORE.PREFIX;
  if (new RegExp(`\\b${escapeRegExp(needle)}`, "u").test(haystack)) {
    return SEARCH_TITLE_SCORE.WORD_BOUNDARY;
  }
  if (haystack.includes(needle)) return SEARCH_TITLE_SCORE.SUBSTRING;
  return null;
}

export interface TitleSearchCandidate {
  id: string;
  title: string;
  publicId?: string;
}

export interface TitleSearchHit<T extends TitleSearchCandidate = TitleSearchCandidate> {
  item: T;
  score: SearchTitleScore;
}

/**
 * Rank candidates by `searchTextScore` ascending (best match first),
 * stable on ties (insertion order preserved). Non-matches are dropped.
 */
export function rankByTitleScore<T extends TitleSearchCandidate>(
  query: string,
  items: readonly T[],
): TitleSearchHit<T>[] {
  const scored: Array<{ hit: TitleSearchHit<T>; index: number }> = [];
  items.forEach((item, index) => {
    const titleScore = searchTextScore(query, item.title);
    const refScore = item.publicId ? searchTextScore(query, item.publicId) : null;
    const score = titleScore === null || (refScore !== null && refScore < titleScore) ? refScore : titleScore;
    if (score !== null) scored.push({ hit: { item, score }, index });
  });
  scored.sort((a, b) => a.hit.score - b.hit.score || a.index - b.index);
  return scored.map(({ hit }) => hit);
}
