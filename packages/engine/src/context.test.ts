import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  parsePagination,
  parseSort,
  requireSession,
} from "./context";
import { MegaBadRequestError, MegaUnauthorizedError } from "./errors";

describe("session context (EG-01)", () => {
  it("accepts a complete session and rejects missing identity", () => {
    expect(
      requireSession({ userId: "usr_tianjing", username: "tianjing", locale: "en" }),
    ).toEqual({ userId: "usr_tianjing", username: "tianjing", locale: "en" });
    expect(() => requireSession(undefined)).toThrow(MegaUnauthorizedError);
    expect(() => requireSession({ userId: "  ", username: "tianjing" })).toThrow(
      MegaUnauthorizedError,
    );
  });
});

describe("pagination / sort parsers (EG-01)", () => {
  it("applies defaults and caps limit", () => {
    expect(parsePagination({})).toEqual({
      offset: 0,
      limit: DEFAULT_PAGE_LIMIT,
    });
    expect(parsePagination({ offset: "5", limit: "10" })).toEqual({
      offset: 5,
      limit: 10,
    });
    expect(() => parsePagination({ limit: MAX_PAGE_LIMIT + 1 })).toThrow(
      MegaBadRequestError,
    );
    expect(() => parsePagination({ offset: -1 })).toThrow(MegaBadRequestError);
    expect(() => parsePagination({ limit: 0 })).toThrow(MegaBadRequestError);
  });

  it("parses sort against an allowlist", () => {
    expect(
      parseSort({}, ["updatedAt", "createdAt"] as const, {
        field: "updatedAt",
        direction: "desc",
      }),
    ).toEqual({ field: "updatedAt", direction: "desc" });
    expect(
      parseSort(
        { sort: "createdAt", direction: "ASC" },
        ["updatedAt", "createdAt"] as const,
        { field: "updatedAt", direction: "desc" },
      ),
    ).toEqual({ field: "createdAt", direction: "asc" });
    expect(() =>
      parseSort({ sort: "secret" }, ["updatedAt"] as const, {
        field: "updatedAt",
        direction: "desc",
      }),
    ).toThrow(MegaBadRequestError);
  });
});
