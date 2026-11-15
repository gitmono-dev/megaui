// megaui:libs/mega/services/search.ts@0ff3a9d
//
// megaui-only additions (EG-10, ADR-FS-01): shared body-search vocabulary.
// English (this card) and CJK (EG-14 — window/round-robin/scale-error,
// explicitly NOT implemented here) both search the same
// `mega_content_blocks` rows over the same kind set; this file only hosts
// the shapes/constants both paths need, no query logic.
import { megaContentContainerTypes } from "@megaui/database";

/**
 * REF-05 `BODY_FTS_KINDS` (ADR-FS-01 §①.3): the body-searchable source
 * kinds. Exact set, exact order — do not add `channel` / `comment` /
 * `release` aliases; ADR-FS-01 explicitly forbids those non-body kinds.
 */
export const BODY_FTS_KINDS = [
  megaContentContainerTypes.DOC,
  megaContentContainerTypes.ISSUE,
  megaContentContainerTypes.CL,
  megaContentContainerTypes.DOC_COMMENT,
  megaContentContainerTypes.ISSUE_COMMENT,
  megaContentContainerTypes.CL_COMMENT,
  megaContentContainerTypes.CHAT_MESSAGE,
] as const;

export type BodyFtsKind = (typeof BODY_FTS_KINDS)[number];

export function isBodyFtsKind(value: string): value is BodyFtsKind {
  return (BODY_FTS_KINDS as readonly string[]).includes(value);
}

/** One `mega_content_blocks` row matched by a body-search query. */
export interface SearchBodyHit {
  sourceType: BodyFtsKind;
  sourceId: string;
  blockId: string;
  textSummary: string;
  /** Higher is more relevant (native `ts_rank`); hits are returned sorted descending. */
  rank: number;
}

export interface SearchBodyQuery {
  query: string;
  /**
   * Defaults to all `BODY_FTS_KINDS` when omitted. An explicitly empty
   * array means "search no kinds" — zero hits, not "search everything"
   * (checklist #4).
   */
  kinds?: readonly string[];
  perKind?: number;
  total?: number;
  offset?: number;
}
