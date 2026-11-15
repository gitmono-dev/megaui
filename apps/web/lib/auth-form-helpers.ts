// megaui-only: small helpers shared by the legacy email/password auth forms.
import type { z } from "zod";

/** Keeps the first message reported for each top-level field of a zod error. */
export function firstIssuePerField<K extends string>(issues: readonly z.core.$ZodIssue[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const issue of issues) {
    const field = issue.path[0] as K | undefined;
    if (field !== undefined && out[field] === undefined) out[field] = issue.message;
  }
  return out;
}

export type AuthErrorState = { code: string; message: string };

/**
 * Turns an auth-client error code into a localised message, falling back to
 * the generic `UNKNOWN_ERROR` entry when the code has no translation.
 */
export function toAuthErrorState(
  catalogue: { UNKNOWN_ERROR: string } & Record<string, string | undefined>,
  code: string | undefined,
): AuthErrorState {
  const resolved = code ?? "UNKNOWN_ERROR";
  return { code: resolved, message: catalogue[resolved] ?? catalogue.UNKNOWN_ERROR };
}
