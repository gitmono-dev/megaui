// megaui:libs/mega/services/search.ts@0ff3a9d
//
// megaui-only additions (EG-10, ADR-FS-01 §①.3/§④): fair-selection budgets
// shared by English (this card) and CJK (EG-14). The round-robin + per-kind
// window itself is EG-14 scope; this file only owns the numeric budget and
// the final offset/total slice, which both paths need.

/** Per-kind fetch budget used to size the CJK window (EG-14). Kept here — not
 * duplicated in english.ts — because ADR-FS-01 §④ names both constants as
 * one pair; English does not partition by kind, so it never reads this one
 * directly, but a caller sizing a combined request still needs a single
 * source of truth. */
export const SEARCH_BODY_PER_KIND = 5;

/** Default total hits returned per body-search request (both English and CJK). */
export const SEARCH_BODY_TOTAL = 30;

/**
 * Hard ceiling on how many rows a single query fetches from Postgres,
 * regardless of offset/total (ADR-FS-01 §④: CJK's
 * `perKindFetch = min(500, ...)` shape; English reuses the same ceiling).
 */
export const SEARCH_BODY_MAX_FETCH_WINDOW = 500;

/**
 * How much wider than `offset + limit` to fetch before slicing in the
 * application layer. The ADR specifies the *shape* of this calculation
 * (`min(500, max(perKind, (offset + perKind) * FETCH_MULTIPLIER))`) but not
 * this multiplier's value — chosen generously so a page near the tail of a
 * moderately-sized result set rarely needs a second round trip.
 */
export const SEARCH_BODY_FETCH_MULTIPLIER = 4;

export interface FetchWindowInput {
  offset?: number;
  limit?: number;
  multiplier?: number;
  maxWindow?: number;
}

/**
 * `min(maxWindow, max(limit, (offset + limit) * multiplier))` — the
 * ADR-FS-01 §④ fetch-window shape, generalized over `limit` (CJK uses
 * `perKind`, English uses `total`).
 */
export function computeFetchWindow(input: FetchWindowInput = {}): number {
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, input.limit ?? SEARCH_BODY_TOTAL);
  const multiplier = input.multiplier ?? SEARCH_BODY_FETCH_MULTIPLIER;
  const maxWindow = input.maxWindow ?? SEARCH_BODY_MAX_FETCH_WINDOW;
  return Math.min(maxWindow, Math.max(limit, (offset + limit) * multiplier));
}

export interface ApplyLimitsInput {
  offset?: number;
  total?: number;
}

/**
 * Cap an already-ordered hit list to the requested page:
 * `slice(offset, offset + total)`. Never reorders — English rank order
 * (`ts_rank` DESC) and any future CJK round-robin order are both
 * established upstream of this call. (ADR-FS-01: English forbids
 * round-robin; that's enforced by never reordering here, not by this
 * function branching on strategy.)
 */
export function applyLimits<T>(hits: readonly T[], input: ApplyLimitsInput = {}): T[] {
  const offset = Math.max(0, input.offset ?? 0);
  const total = Math.max(0, input.total ?? SEARCH_BODY_TOTAL);
  return hits.slice(offset, offset + total);
}
