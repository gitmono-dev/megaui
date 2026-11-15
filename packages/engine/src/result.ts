// megaui:libs/mega/types.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-01 task card):
// PK-01 parked MegaApiSuccess / MegaApiFailure out of @megaui/core (they are
// a transport envelope, not a domain noun). This file owns that envelope as
// the engine result contract. WA-03 maps it onto HTTP; this module does not.
import { MegaBadRequestError, MegaError, MegaInternalError, MEGA_ERROR_CODES } from "./errors";
import { z } from "zod";

export interface MegaApiSuccess<T> {
  data: T;
}

export interface MegaApiFailure {
  error: {
    code: string;
    message: string;
  };
}

export type MegaApiResult<T> = MegaApiSuccess<T> | MegaApiFailure;

export function megaOk<T>(data: T): MegaApiSuccess<T> {
  return { data };
}

export function megaFail(code: string, message: string): MegaApiFailure {
  return { error: { code, message } };
}

export function isMegaApiSuccess<T>(
  value: MegaApiResult<T>,
): value is MegaApiSuccess<T> {
  return "data" in value && !("error" in value);
}

export function isMegaApiFailure(
  value: MegaApiResult<unknown>,
): value is MegaApiFailure {
  return "error" in value;
}

function isZodError(error: unknown): error is z.core.$ZodError {
  return error instanceof z.ZodError;
}

function formatZodError(error: z.core.$ZodError): string {
  return z.prettifyError(error).trim() || "Invalid Mega API input";
}

/**
 * Serialize any thrown value into the Mega API failure envelope.
 * Unknown / internal errors never leak their original message (GC-07 / ER-11).
 */
export function serializeMegaError(error: unknown): MegaApiFailure {
  if (error instanceof MegaInternalError) {
    return megaFail(
      MEGA_ERROR_CODES.INTERNAL,
      "Unable to process Mega request",
    );
  }
  if (error instanceof MegaError) {
    return megaFail(error.code, error.message);
  }
  if (isZodError(error)) {
    return megaFail(MEGA_ERROR_CODES.BAD_REQUEST, formatZodError(error));
  }
  return megaFail(
    MEGA_ERROR_CODES.INTERNAL,
    "Unable to process Mega request",
  );
}

export const megaApiSuccessSchema = z.object({
  data: z.unknown(),
});

export const megaApiFailureSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export function parseMegaApiResult<T>(value: unknown): MegaApiResult<T> {
  if (value === null || typeof value !== "object") {
    throw new MegaBadRequestError("value is not a Mega API result");
  }
  const record = value as Record<string, unknown>;
  if ("data" in record && "error" in record) {
    throw new MegaBadRequestError("value is not a Mega API result");
  }
  const failure = megaApiFailureSchema.safeParse(value);
  if (failure.success) {
    return failure.data;
  }
  const success = megaApiSuccessSchema.safeParse(value);
  if (success.success) {
    return { data: success.data.data as T };
  }
  throw new MegaBadRequestError("value is not a Mega API result");
}
