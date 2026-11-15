// megaui:libs/mega/services/types.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-01 task card):
// - Adds MegaError as a shared base so serializeMegaError can distinguish
//   domain errors from unknown throws without an instanceof ladder on every
//   subclass.
// - Adds MegaUnauthorizedError (code already existed on MEGA_ERROR_CODES).
// - Adds MegaInternalError for explicit internal failures (still serialized
//   without leaking cause messages).
// - Adds SearchCjkScaleExceededError (EG-14, ADR-FS-01 Consequences #3): a
//   domain error only — mapping `SEARCH_CJK_SCALE_EXCEEDED` to an HTTP
//   status (503) and the `{ error: { code, messageKey } }` envelope is
//   WA-05's job, not this package's.

export const MEGA_ERROR_CODES = {
  BAD_REQUEST: "MEGA_BAD_REQUEST",
  NOT_FOUND: "MEGA_NOT_FOUND",
  CONFLICT: "MEGA_CONFLICT",
  TITLE_CONFLICT: "TITLE_CONFLICT",
  FORBIDDEN: "MEGA_FORBIDDEN",
  INTERNAL: "MEGA_INTERNAL_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  SEARCH_CJK_SCALE_EXCEEDED: "SEARCH_CJK_SCALE_EXCEEDED",
} as const;

export type MegaErrorCode =
  (typeof MEGA_ERROR_CODES)[keyof typeof MEGA_ERROR_CODES];

export abstract class MegaError extends Error {
  abstract readonly code: MegaErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MegaConflictError extends MegaError {
  readonly code = MEGA_ERROR_CODES.CONFLICT;
}

export class MegaTitleConflictError extends MegaError {
  readonly code = MEGA_ERROR_CODES.TITLE_CONFLICT;

  constructor(title: string) {
    super(`Document title already exists: ${title}`);
  }
}

export class MegaNotFoundError extends MegaError {
  readonly code = MEGA_ERROR_CODES.NOT_FOUND;

  constructor(entity: string, id: string | number) {
    super(`${entity} not found: ${id}`);
  }
}

export class MegaBadRequestError extends MegaError {
  readonly code = MEGA_ERROR_CODES.BAD_REQUEST;
}

export class MegaForbiddenError extends MegaError {
  readonly code = MEGA_ERROR_CODES.FORBIDDEN;
}

export class MegaUnauthorizedError extends MegaError {
  readonly code = MEGA_ERROR_CODES.UNAUTHORIZED;
}

export class MegaInternalError extends MegaError {
  readonly code = MEGA_ERROR_CODES.INTERNAL;
}

/**
 * ADR-FS-01 §④/Consequences #3 (EG-14): thrown when `mega_content_blocks`
 * exceeds the CJK substring-scan's fail-closed row-count ceiling
 * (`SEARCH_CJK_MAX_BLOCKS`, defined in `services/search/cjk.ts` — kept
 * there, not here, since it's a CJK-search-specific budget, not a
 * generic error concern). A domain error, not an HTTP concern: no status
 * code is attached here (WA-05 maps this code to a 503 response).
 */
export class SearchCjkScaleExceededError extends MegaError {
  readonly code = MEGA_ERROR_CODES.SEARCH_CJK_SCALE_EXCEEDED;

  constructor(blockCount: number, maxBlocks: number) {
    super(
      `CJK substring search is disabled: mega_content_blocks has ${blockCount} rows, exceeding the ${maxBlocks}-row fail-closed ceiling (ADR-FS-01 §④/Consequences #3).`,
    );
  }
}

export function isMegaError(error: unknown): error is MegaError {
  return error instanceof MegaError;
}
