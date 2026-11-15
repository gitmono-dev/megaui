// megaui:libs/mega/services/monoengine/types.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-11 task card):
// - Card scope is 5 read endpoints only (latest-commit, tree,
//   tree/commit-info, blob, cl/{link}/commits — REF-02). The
//   user-credentials / user-notifications / ssh-key-validation /
//   user-mappers / readme-markdown wire shapes from the same upstream
//   directory are not ported here; they belong to later cards (WA-18
//   credentials) that will pin their own REF-02 slice.
// - `Mega2ConfigError` now extends the engine's `MegaInternalError`
//   instead of a standalone `Error` subclass with its own ad-hoc
//   `code`/`name` fields — single domain-error exit (DEBT-03/GC-04); the
//   fail-closed behavior (thrown when `MEGA2_PUBLIC_BASE_URL` is
//   unset) is unchanged.
// - `ClCommit` / `clCommitWireSchema` / `clCommitsWireSchema` /
//   `ClCommitWire` move here from `@megaui/core` per that package's
//   README ("mega2 wire-format mapping is a BFF/engine adapter
//   concern, not a core domain shape ... belongs in `@megaui/engine`").
// - `SourceFileView` (upstream `services/types.ts`) moves here for the
//   same reason: it is the wire-derived shape (`lines`/`sizeBytes`) layered
//   on top of `@megaui/core`'s `SourceFile` domain type.
// - Added a generic `commonResultWireSchema(dataSchema)` zod helper so the
//   `CommonResult<T>` envelope is validated structurally instead of assumed
//   (upstream trusted `response.json()` at the `CommonResult<T>` type
//   without runtime validation).
import { z } from "zod";
import type { SourceFile } from "@megaui/core";
import { MegaInternalError } from "../../errors";

/** Thrown fail-closed when `MEGA2_PUBLIC_BASE_URL` is unset (card AC3). */
export class Mega2ConfigError extends MegaInternalError {}

export function commonResultWireSchema<Schema extends z.ZodTypeAny>(
  dataSchema: Schema,
) {
  return z.object({
    req_result: z.boolean(),
    data: dataSchema.nullable(),
    err_message: z.string(),
  });
}

export const latestCommitWireSchema = z.object({
  oid: z.string(),
  date: z.string(),
  short_message: z.string(),
  author: z.string(),
  committer: z.string(),
  status: z.string(),
});
export type LatestCommitInfo = z.output<typeof latestCommitWireSchema>;

export const treeBriefItemWireSchema = z.object({
  name: z.string(),
  path: z.string(),
  content_type: z.string(),
});
export type TreeBriefItemWire = z.output<typeof treeBriefItemWireSchema>;

export const treeResponseWireSchema = z.object({
  file_tree: z.record(
    z.string(),
    z.object({
      tree_items: z.array(treeBriefItemWireSchema),
      total_count: z.number(),
    }),
  ),
  tree_items: z.array(treeBriefItemWireSchema),
});
export type TreeResponseWire = z.output<typeof treeResponseWireSchema>;

export const treeCommitItemWireSchema = z.object({
  commit_id: z.string(),
  name: z.string(),
  content_type: z.string(),
  commit_message: z.string(),
  date: z.string(),
});
export const treeCommitItemsWireSchema = z.array(treeCommitItemWireSchema);
export type TreeCommitItemWire = z.output<typeof treeCommitItemWireSchema>;

export const blobWireSchema = z.string();

/**
 * The `GET /api/v1/cl/{link}/commits` wire payload is snake_case; this
 * schema's transform is the single camelCase conversion point, so every
 * caller past this module only ever sees camelCase records.
 */
export const clCommitWireSchema = z
  .object({
    sha: z.string(),
    message: z.string(),
    author_name: z.string(),
    author_email: z.string(),
  })
  .transform((wire) => ({
    sha: wire.sha,
    message: wire.message,
    authorName: wire.author_name,
    authorEmail: wire.author_email,
  }));
export const clCommitsWireSchema = z.array(clCommitWireSchema);

/** Wire input shape accepted from mega2 (pre-transform). */
export type ClCommitWire = z.input<typeof clCommitWireSchema>;
/** CL commit metadata after schema transform — always camelCase past this module. */
export type ClCommit = z.output<typeof clCommitWireSchema>;

export interface SourceFileView extends SourceFile {
  lines: number;
  sizeBytes: number;
}

export interface MapperOptions {
  workspaceName?: string;
  workspaceDescription?: string;
  monorepoRootDirs?: readonly string[];
  authorPlaceholder?: string;
}
