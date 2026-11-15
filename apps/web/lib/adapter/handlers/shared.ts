// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (segment helpers + zod schemas)
//
// Diff vs upstream (GC-03 / WA-04):
// - Shared route parsing for docs/issues/cls handlers only (not the full
//   mega-api monolith). Chat/agg routes land in WA-05.

import {
  MEGA_CL_LABELS,
  MEGA_FILTER_SORTS,
  MEGA_ISSUE_PRIORITIES,
  MEGA_ISSUE_STATES,
} from "@megaui/core";
import { MegaNotFoundError } from "@megaui/engine";
import { z } from "zod";

import { MegaApiInputError } from "../errors";

export const issueStateSchema = z.enum(MEGA_ISSUE_STATES);
export const clStateSchema = z.enum(
  Object.keys(MEGA_CL_LABELS) as [
    keyof typeof MEGA_CL_LABELS,
    ...(keyof typeof MEGA_CL_LABELS)[],
  ],
);
export const prioritySchema = z.enum(MEGA_ISSUE_PRIORITIES);

export const filterSchema = z.object({
  text: z.string().trim().min(1).optional(),
  states: z
    .array(z.union([issueStateSchema, clStateSchema]))
    .optional(),
  priority: z
    .object({
      min: prioritySchema.optional(),
      max: prioritySchema.optional(),
      values: z.array(prioritySchema).optional(),
    })
    .optional(),
  packageIds: z
    .union([z.array(z.string().trim().min(1)), z.literal("all")])
    .optional(),
  labels: z.array(z.string().trim().min(1)).optional(),
  assignee: z.string().trim().min(1).optional(),
  author: z.string().trim().min(1).optional(),
  reviewer: z.string().trim().min(1).optional(),
  sort: z.enum(MEGA_FILTER_SORTS).optional(),
});

export const createIssueSchema = z.object({
  title: z.string().trim().min(1),
  packageId: z.string().trim().min(1),
  priority: prioritySchema,
  body: z.string().trim().min(1).optional(),
});

export const createDocSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1).optional(),
  excerpt: z.string().optional(),
  folderId: z.string().trim().min(1).optional(),
  tagIds: z.array(z.string().trim().min(1)).optional(),
});

export const saveDocSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  excerpt: z.string().optional(),
  summary: z.string().optional(),
});

export const backlinkTargetKindSchema = z.enum(["doc", "issue", "cl"]);

const positiveNumber = z.coerce.number().int().positive();
const nonEmptyString = z.string().trim().min(1);

export function readJsonQuery(value: string | null, fallback: unknown): unknown {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new MegaApiInputError("Query parameter must contain valid JSON");
  }
}

export function only(
  segments: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    segments.length === expected.length &&
    segments.every((segment, index) => segment === expected[index])
  );
}

export function segmentNumber(value: string | undefined): number {
  return positiveNumber.parse(value);
}

export function segmentText(value: string | undefined): string {
  return nonEmptyString.parse(value);
}

export function invalidRoute(segments: readonly string[]): never {
  throw new MegaNotFoundError("Mega resource", segments.join("/") || "root");
}
