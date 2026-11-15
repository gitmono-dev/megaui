// megaui-only (EG-10/EG-14, ADR-FS-01): search-domain barrel. Both the
// English (`english.ts`, EG-10) and CJK (`cjk.ts`, EG-14) body-search paths
// are exported here, alongside the shared title/limits/type scaffolding
// both depend on.
export {
  BODY_FTS_KINDS,
  isBodyFtsKind,
  type BodyFtsKind,
  type SearchBodyHit,
  type SearchBodyQuery,
} from "./types";
export {
  applyLimits,
  computeFetchWindow,
  SEARCH_BODY_FETCH_MULTIPLIER,
  SEARCH_BODY_MAX_FETCH_WINDOW,
  SEARCH_BODY_PER_KIND,
  SEARCH_BODY_TOTAL,
  type ApplyLimitsInput,
  type FetchWindowInput,
} from "./limits";
export { searchEnglish } from "./english";
export { containsCjkScript, searchCjk, SEARCH_CJK_MAX_BLOCKS } from "./cjk";
export {
  rankByTitleScore,
  searchTextScore,
  SEARCH_TITLE_SCORE,
  type SearchTitleScore,
  type TitleSearchCandidate,
  type TitleSearchHit,
} from "./title";
