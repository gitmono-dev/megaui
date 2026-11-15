// megaui:libs/mega/services/monoengine/code-backend.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-11 task card):
// - `fetchReadmeBlocks` (README markdown rendering) is not ported — it is
//   built purely from `fetchSourceFile` + a markdown→`ProseBlock[]` parser
//   that is not part of this card's REF-02 endpoint list; a page card
//   (WA-08) can compose it from `fetchSourceFile` plus the existing
//   `docs/blocks.ts` markdown parser instead of duplicating that logic here.
// - Every function now takes a trailing `env: NodeJS.ProcessEnv = process.env`
//   parameter (matching `client.ts`) instead of always reading
//   `process.env` — this is what lets the contract tests point at a local
//   stub server without mutating global process state.
// - `getClCommits` (upstream lived in `client.ts`) moves here as
//   `fetchClCommits`, alongside the other 4 endpoint wrappers, since it is
//   equally a "code-backend" domain call and this card scopes `client.ts`
//   to transport-only concerns.
// - No mock-vs-mega2 data-backend selector branch and no mock
//   fallback (DEBT-04) — every function here always calls mega2; the
//   selector in upstream `services/code.ts` is intentionally not ported.
import type { RootEntry, TreeNode, Workspace } from "@megaui/core";
import { sortTreeNodesByKindThenName } from "@megaui/core";
import {
  getMega2CommonResult,
  getMega2Json,
  normalizeRepoPath,
  type Mega2RequestOptions,
} from "./client";
import { toRootEntries, toSourceFile, toTreeNodes, toWorkspace } from "./mappers";
import {
  blobWireSchema,
  clCommitsWireSchema,
  latestCommitWireSchema,
  treeCommitItemsWireSchema,
  treeResponseWireSchema,
  type ClCommit,
  type MapperOptions,
  type SourceFileView,
} from "./types";

export interface CodeBackendOptions extends Mega2RequestOptions {
  mapperOptions?: MapperOptions;
}

/** mega2 HEAD when unset; override with `MEGA_CODE_REFS` when a named ref exists. */
function codePreviewSearchParams(
  path: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const refs = env.MEGA_CODE_REFS?.trim();
  const params: Record<string, string> = { path: normalizeRepoPath(path) };
  if (refs) {
    params.refs = refs;
  }
  return params;
}

export async function fetchWorkspace(
  options: CodeBackendOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Workspace> {
  const latest = await getMega2Json(
    "/api/v1/latest-commit",
    latestCommitWireSchema,
    { ...options, searchParams: codePreviewSearchParams("/", env) },
    env,
  );
  return toWorkspace(latest, options.mapperOptions);
}

export async function fetchRootEntries(
  options: CodeBackendOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootEntry[]> {
  const items = await getMega2CommonResult(
    "/api/v1/tree/commit-info",
    treeCommitItemsWireSchema,
    { ...options, searchParams: codePreviewSearchParams("/", env) },
    env,
  );
  return sortTreeNodesByKindThenName(toRootEntries(items, options.mapperOptions));
}

export async function fetchCodeTree(
  path: string | undefined,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly TreeNode[]> {
  const response = await getMega2CommonResult(
    "/api/v1/tree",
    treeResponseWireSchema,
    { ...options, searchParams: codePreviewSearchParams(path ?? "/", env) },
    env,
  );
  return toTreeNodes(response);
}

export async function fetchSourceFile(
  path: string,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SourceFileView> {
  const content = await getMega2CommonResult(
    "/api/v1/blob",
    blobWireSchema,
    { ...options, searchParams: codePreviewSearchParams(path, env) },
    env,
  );
  return toSourceFile(path, content);
}

/**
 * List a CL's commits in chain order (DEP-01 upstream note: only the random
 * `link` is accepted, never a CL number).
 */
export async function fetchClCommits(
  link: string,
  options: Mega2RequestOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ClCommit[]> {
  return getMega2CommonResult(
    `/api/v1/cl/${encodeURIComponent(link)}/commits`,
    clCommitsWireSchema,
    options,
    env,
  );
}
