// megaui-only (WA-03): HTTP serialization for `@megaui/engine` Mega API envelope.
//
// Diff vs upstream (GC-03 / DEBT-03):
// - Centralizes success/failure JSON in DIR-03 instead of per-route mapping
//   (megaui:apps/next-app/app/api/mega/[...segments]/route.ts@0ff3a9d).

import {
  megaApiFailureSchema,
  megaApiSuccessSchema,
  type MegaApiFailure,
  type MegaApiSuccess,
} from "@megaui/engine";
import { NextResponse } from "next/server";

/** HTTP failure body extends the engine envelope with a stable i18n key (GC-04). */
export interface MegaHttpFailureBody extends MegaApiFailure {
  error: MegaApiFailure["error"] & {
    messageKey: string;
  };
}

export function megaSuccessResponse<T>(
  data: T,
): NextResponse<MegaApiSuccess<T | null>> {
  // JSON.stringify drops `undefined` values; UI-04 fetcher requires a `data` key.
  return NextResponse.json({ data: data === undefined ? null : data });
}

export function megaFailureResponse(
  body: MegaHttpFailureBody,
  status: number,
): NextResponse<MegaHttpFailureBody> {
  return NextResponse.json(body, { status });
}

export function assertMegaSuccessEnvelope(value: unknown): asserts value is MegaApiSuccess<unknown> {
  const parsed = megaApiSuccessSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Expected Mega API success envelope");
  }
}

export function assertMegaFailureEnvelope(value: unknown): asserts value is MegaHttpFailureBody {
  const parsed = megaApiFailureSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Expected Mega API failure envelope");
  }
  const record = value as MegaHttpFailureBody;
  if (typeof record.error.messageKey !== "string" || !record.error.messageKey) {
    throw new Error("Expected Mega API failure envelope messageKey");
  }
}
