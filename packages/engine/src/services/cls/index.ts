import type { Database } from "@megaui/database";
import { createClsService, type ClsService } from "./cls";

export { assertWorkspaceMember } from "./authz";
export { createClsService, type ClsService } from "./cls";
export { ensureCLPublicId, lockCLNumberAllocation, nextCLNumber, resolveCLNumber } from "./public-id";
export { aggregateCheckStatus, deleteCLCheckRun, getCLChecks, upsertCLCheckRun, type CLCheckRunInput, type CLChecksView } from "./checks";
export {
  importPlainText,
  isEmptyCommentBody,
  normalizeCommentBodyJson,
  plainTextFromCommentBody,
} from "./comment-body";
export { normalizeCLDescriptionJson, plainSummaryFromDescription } from "./description";
export {
  detectDependencyCycles,
  getCLDependencyGraph,
  setCLDependencyGraph,
  type CLDependencyGraphResult,
  type CLDependencyView,
  type SetCLDependencyGraphInput,
} from "./deps";
export {
  addInlineComment,
  listInlineComments,
  replyInlineComment,
  resolveInlineComment,
  setCLFileViewed,
  type AddInlineCommentInput,
} from "./inline";
export {
  createCLRevision,
  listCLRevisions,
  parseRevisions,
  type CreateCLRevisionInput,
} from "./revisions";
export {
  assertCLTransitionAllowed,
  CL_STATE_TRANSITIONS,
  decideCLTransition,
  mergeStateForTransition,
  resolveCLTransitionActorRole,
  type CLTransitionActorRole,
  type CLTransitionDecision,
  type CLTransitionDenialReason,
} from "./state";
export type { CLDescriptionPayload, CreateCLInput } from "./types";

export interface ClsDomain {
  cls: ClsService;
}

/** Wires the CL-domain service against one `Database` (EG-05). */
export function createClsDomain(database: Database): ClsDomain {
  return { cls: createClsService(database) };
}
