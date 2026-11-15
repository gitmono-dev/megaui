import { describe, expect, it } from "vitest";
import {
  isMegaError,
  MEGA_ERROR_CODES,
  MegaBadRequestError,
  MegaConflictError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaTitleConflictError,
  MegaUnauthorizedError,
  SearchCjkScaleExceededError,
} from "./errors";

describe("domain errors (EG-01)", () => {
  it("exposes the canonical code table", () => {
    expect(MEGA_ERROR_CODES).toEqual({
      BAD_REQUEST: "MEGA_BAD_REQUEST",
      NOT_FOUND: "MEGA_NOT_FOUND",
      CONFLICT: "MEGA_CONFLICT",
      TITLE_CONFLICT: "TITLE_CONFLICT",
      FORBIDDEN: "MEGA_FORBIDDEN",
      INTERNAL: "MEGA_INTERNAL_ERROR",
      UNAUTHORIZED: "UNAUTHORIZED",
      SEARCH_CJK_SCALE_EXCEEDED: "SEARCH_CJK_SCALE_EXCEEDED",
    });
  });

  it("is identifiable via MegaError and keeps stable codes", () => {
    const errors = [
      new MegaBadRequestError("bad"),
      new MegaNotFoundError("Issue", 7),
      new MegaConflictError("clash"),
      new MegaTitleConflictError("dup"),
      new MegaForbiddenError("no"),
      new MegaUnauthorizedError("auth"),
      new MegaInternalError("boom"),
      new SearchCjkScaleExceededError(200_001, 200_000),
    ];
    for (const error of errors) {
      expect(isMegaError(error)).toBe(true);
      expect(error.code).toBeTruthy();
    }
    expect(isMegaError(new Error("nope"))).toBe(false);
  });
});
