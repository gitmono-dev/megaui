// megaui:libs/mega/services/monoengine/mappers.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-11 task card):
// - Input types are the local zod-inferred wire shapes (`./types`) instead
//   of the upstream hand-written interfaces; behavior is unchanged.
// - `toWorkspace` no longer sets `starSupported` — `@megaui/core`'s
//   `Workspace` dropped that field (backend-mode capability negotiation is
//   an adapter concern per the core package README); star state is owned
//   by the caller (BFF), not this mapper.
import type { Package, RootEntry, TreeNode, User, Workspace } from "@megaui/core";
import { sortTreeNodesByKindThenName } from "@megaui/core";
import type {
  LatestCommitInfo,
  MapperOptions,
  SourceFileView,
  TreeCommitItemWire,
  TreeResponseWire,
} from "./types";

const DEFAULT_MONOREPO_ROOT_DIRS = [
  "third-party",
  "project",
  "doc",
  "artifact",
  "release",
  "model",
  "data",
  "toolchains",
] as const;

const EXTENSION_LANGUAGE: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  json: "json",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  go: "go",
  sh: "bash",
};

function resolveMapperOptions(options: MapperOptions = {}) {
  const envDirs = process.env.MEGA_MONOREPO_ROOT_DIRS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    workspaceName: options.workspaceName ?? process.env.MEGA_WORKSPACE_NAME?.trim() ?? "mega2",
    workspaceDescription: options.workspaceDescription ?? process.env.MEGA_WORKSPACE_DESCRIPTION?.trim() ?? "",
    monorepoRootDirs: options.monorepoRootDirs ?? envDirs ?? DEFAULT_MONOREPO_ROOT_DIRS,
    authorPlaceholder: options.authorPlaceholder ?? process.env.MEGA_WORKSPACE_NAME?.trim() ?? "mega2",
  };
}

function toRelativePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function toTreeNodeKind(contentType: string): TreeNode["kind"] {
  return contentType === "directory" ? "directory" : "file";
}

function toIsoDate(value: string): string {
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && value.trim() !== "") {
    return new Date(numeric * 1000).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}

function placeholderAuthor(name: string): User {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return {
    id: name,
    username: name,
    displayName: name,
    avatarInitials: initial,
  };
}

function toPackage(name: string): Package {
  return {
    id: name,
    name,
    version: "0.0.0",
    path: name,
    owners: [],
    ci: "passing",
    dependencyCount: 0,
    usedByCount: 0,
    indexed: false,
  };
}

export function languageFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (!extension) {
    return "plaintext";
  }
  return EXTENSION_LANGUAGE[extension] ?? "plaintext";
}

export function toWorkspace(latest: LatestCommitInfo, options?: MapperOptions): Workspace {
  const resolved = resolveMapperOptions(options);
  return {
    id: "workspace",
    name: resolved.workspaceName,
    description: resolved.workspaceDescription,
    defaultBranch: "main",
    headSha: latest.oid,
    starred: false,
    packages: resolved.monorepoRootDirs.map(toPackage),
  };
}

export function toRootEntries(
  items: readonly TreeCommitItemWire[],
  options?: MapperOptions,
): RootEntry[] {
  const resolved = resolveMapperOptions(options);
  const author = placeholderAuthor(resolved.authorPlaceholder);
  return items.map((item) => ({
    name: item.name,
    path: item.name,
    kind: toTreeNodeKind(item.content_type),
    lastCommitMessage: item.commit_message,
    updatedAt: toIsoDate(item.date),
    author,
    packageId: resolved.monorepoRootDirs.includes(item.name) ? item.name : undefined,
  }));
}

export function toTreeNodes(response: TreeResponseWire): TreeNode[] {
  return sortTreeNodesByKindThenName(
    response.tree_items.map((item) => ({
      name: item.name,
      path: toRelativePath(item.path || item.name),
      kind: toTreeNodeKind(item.content_type),
    })),
  );
}

export function toSourceFile(path: string, content: string): SourceFileView {
  return {
    path,
    content,
    language: languageFromPath(path),
    lines: content.split("\n").length,
    sizeBytes: new TextEncoder().encode(content).length,
  };
}
