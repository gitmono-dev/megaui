import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MegaBadRequestError,
  MegaInternalError,
  MegaNotFoundError,
  MegaTitleConflictError,
} from "./errors";
import {
  isMegaApiFailure,
  isMegaApiSuccess,
  megaFail,
  megaOk,
  parseMegaApiResult,
  serializeMegaError,
} from "./result";

describe("Mega API result envelope (EG-01)", () => {
  it("wraps success and failure payloads", () => {
    const success = megaOk({ id: "doc_1" });
    const failure = megaFail("MEGA_NOT_FOUND", "Document not found: doc_1");
    expect(isMegaApiSuccess(success)).toBe(true);
    expect(isMegaApiFailure(failure)).toBe(true);
    expect(success).toEqual({ data: { id: "doc_1" } });
    expect(failure).toEqual({
      error: { code: "MEGA_NOT_FOUND", message: "Document not found: doc_1" },
    });
  });

  it("round-trips through the zod envelope schemas", () => {
    const parsedSuccess = parseMegaApiResult<{ id: string }>({
      data: { id: "doc_1" },
    });
    const parsedFailure = parseMegaApiResult({
      error: { code: "MEGA_FORBIDDEN", message: "not allowed" },
    });
    expect(parsedSuccess).toEqual({ data: { id: "doc_1" } });
    expect(parsedFailure).toEqual({
      error: { code: "MEGA_FORBIDDEN", message: "not allowed" },
    });
    expect(() => parseMegaApiResult({ nope: true })).toThrow(
      MegaBadRequestError,
    );
  });

  it("serializes domain errors, zod issues, and unknown throws", () => {
    expect(serializeMegaError(new MegaNotFoundError("Document", "doc_1"))).toEqual(
      {
        error: {
          code: "MEGA_NOT_FOUND",
          message: "Document not found: doc_1",
        },
      },
    );
    expect(serializeMegaError(new MegaTitleConflictError("Architecture overview"))).toEqual(
      {
        error: {
          code: "TITLE_CONFLICT",
          message: "Document title already exists: Architecture overview",
        },
      },
    );

    const schema = z.object({ title: z.string().min(1) });
    const parsed = schema.safeParse({ title: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected zod failure");
    const zodFailure = serializeMegaError(parsed.error);
    expect(zodFailure.error.code).toBe("MEGA_BAD_REQUEST");
    expect(zodFailure.error.message).toMatch(/title/i);

    expect(serializeMegaError(new Error("secret connection string"))).toEqual({
      error: {
        code: "MEGA_INTERNAL_ERROR",
        message: "Unable to process Mega request",
      },
    });
    expect(
      serializeMegaError(new MegaInternalError("postgres://secret@localhost/db")),
    ).toEqual({
      error: {
        code: "MEGA_INTERNAL_ERROR",
        message: "Unable to process Mega request",
      },
    });
    expect(() =>
      parseMegaApiResult({
        data: 1,
        error: { code: "MEGA_BAD_REQUEST", message: "nope" },
      }),
    ).toThrow(MegaBadRequestError);
  });
});
