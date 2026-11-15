// megaui-only (WA-08): DIR-03 code composition over EG-11 mega2 client.
// Fail-closed — no mock/fixture fallback (DEBT-04).

import type { ProseBlock, RootEntry, TreeNode, Workspace } from "@megaui/core";
import {
  fetchCodeTree,
  fetchRootEntries,
  fetchSourceFile,
  fetchWorkspace,
  type SourceFileView,
} from "@megaui/engine";

import { markdownToProseBlocks } from "./markdown-to-prose";

export type CodeRequestHeaders = HeadersInit | undefined;

export async function getWorkspace(headers?: CodeRequestHeaders): Promise<Workspace> {
  return fetchWorkspace({ headers });
}

export async function getRootEntries(headers?: CodeRequestHeaders): Promise<RootEntry[]> {
  return fetchRootEntries({ headers });
}

export async function getCodeTree(
  path: string | undefined,
  headers?: CodeRequestHeaders,
): Promise<readonly TreeNode[]> {
  return fetchCodeTree(path, { headers });
}

export async function getSourceFile(
  path: string,
  headers?: CodeRequestHeaders,
): Promise<SourceFileView> {
  return fetchSourceFile(path, { headers });
}

export async function getReadmeBlocks(
  path: string | undefined,
  headers?: CodeRequestHeaders,
): Promise<readonly ProseBlock[]> {
  const filePath = path?.trim() || "README.md";
  const file = await fetchSourceFile(filePath, { headers });
  return markdownToProseBlocks(file.content);
}
