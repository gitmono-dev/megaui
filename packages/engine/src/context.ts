// megaui-only (EG-01): session + pagination/sort parsers. Upstream services
// threaded a raw currentUserId string and ad-hoc limit/offset; this module
// is the shared fail-closed parser later EG-* services consume.
import { MegaBadRequestError, MegaUnauthorizedError } from "./errors";

export interface SessionContext {
  userId: string;
  username: string;
  locale?: string;
}

export function requireSession(
  input: Partial<SessionContext> | null | undefined,
): SessionContext {
  const userId = input?.userId?.trim() ?? "";
  const username = input?.username?.trim() ?? "";
  if (!userId || !username) {
    throw new MegaUnauthorizedError("A signed-in session is required");
  }
  const locale = input?.locale?.trim();
  return locale ? { userId, username, locale } : { userId, username };
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface Pagination {
  offset: number;
  limit: number;
}

export interface PaginationInput {
  offset?: unknown;
  limit?: unknown;
}

function parseNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const asNumber =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(asNumber) || asNumber < 0) {
    throw new MegaBadRequestError(`${field} must be a non-negative integer`);
  }
  return asNumber;
}

export function parsePagination(
  input: PaginationInput = {},
  options?: { defaultLimit?: number; maxLimit?: number },
): Pagination {
  const defaultLimit = options?.defaultLimit ?? DEFAULT_PAGE_LIMIT;
  const maxLimit = options?.maxLimit ?? MAX_PAGE_LIMIT;
  const offset = parseNonNegativeInt(input.offset, "offset") ?? 0;
  const limit = parseNonNegativeInt(input.limit, "limit") ?? defaultLimit;
  if (limit < 1) {
    throw new MegaBadRequestError("limit must be at least 1");
  }
  if (limit > maxLimit) {
    throw new MegaBadRequestError(`limit must be at most ${maxLimit}`);
  }
  return { offset, limit };
}

export type SortDirection = "asc" | "desc";

export interface SortSpec<F extends string = string> {
  field: F;
  direction: SortDirection;
}

export interface SortInput {
  sort?: unknown;
  direction?: unknown;
}

export function parseSort<F extends string>(
  input: SortInput = {},
  allowedFields: readonly F[],
  defaults: SortSpec<F>,
): SortSpec<F> {
  if (allowedFields.length === 0) {
    throw new MegaBadRequestError("sort is not allowed for this resource");
  }
  const fieldRaw =
    input.sort === undefined || input.sort === null || input.sort === ""
      ? defaults.field
      : String(input.sort);
  if (!allowedFields.includes(fieldRaw as F)) {
    throw new MegaBadRequestError(
      `sort must be one of: ${allowedFields.join(", ")}`,
    );
  }
  const directionRaw =
    input.direction === undefined ||
    input.direction === null ||
    input.direction === ""
      ? defaults.direction
      : String(input.direction).toLowerCase();
  if (directionRaw !== "asc" && directionRaw !== "desc") {
    throw new MegaBadRequestError("direction must be asc or desc");
  }
  return { field: fieldRaw as F, direction: directionRaw };
}
