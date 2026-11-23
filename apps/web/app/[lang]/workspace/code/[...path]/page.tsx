// megaui:apps/next-app/app/[lang]/workspace/code/[...path]/code-path-client.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-08): lazy Mega2 tree, ReadmeProse preview, and
// binary/oversized file fallback without an outline pane or resizable shell.
"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ProseBlock, TreeNode, Workspace } from "@megaui/core";
import { sortTreeNodesByKindThenName } from "@megaui/core";
import type { FileTreeNode } from "@megaui/ui/file-tree";
import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";

import { useTranslation } from "@/hooks/use-translation";

import { CodePathContent, type CodePathContentState } from "./components/code-path-content";
import { CodePathHeader } from "./components/code-path-header";
import { CodePathTree } from "./components/code-path-tree";
import { CodePathLoading, CodePathTreeError } from "./components/code-path-tree-state";
import { ancestorPaths, findNode, mergeTreeNodes, readRememberedDirectories, rememberDirectory } from "./lib/code-path-tree";
import { shouldForcePlainText, type SourceFilePayload } from "./lib/code-path-source";

// megaui-only (FS-92): wait for navigation before mounting actionable content.
export default function CodePathPage() {
  const params = useParams<{ lang: string; path?: string[] }>();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  if (params === null || searchParams === null) return <CodePathLoading label={t.workspace.code.loading} />;
  return <ReadyCodePathPage params={params} searchParams={searchParams} />;
}

function ReadyCodePathPage({ params, searchParams }: {
  params: { lang: string; path?: string[] };
  searchParams: NonNullable<ReturnType<typeof useSearchParams>>;
}) {
  const router = useRouter();
  const { locale, t } = useTranslation();
  const code = t.workspace.code;
  const workspaceBase = `/${locale}/workspace`;
  const pathSegments = (params.path ?? []).map((segment) => decodeURIComponent(segment));
  const fullPath = pathSegments.join("/");
  const requestedTab = searchParams.get("tab");
  const contextKey = `${workspaceBase}/code/${fullPath}?${searchParams.toString()}`;
  const currentContext = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = null; };
  }, [contextKey]);
  const [loadedDirs, setLoadedDirs] = useState(
    () => new Set(["", ...ancestorPaths(fullPath), ...readRememberedDirectories()]),
  );

  useEffect(() => {
    setLoadedDirs((current) => new Set([...current, "", ...ancestorPaths(fullPath)]));
  }, [fullPath]);

  const workspaceQuery = useQuery({
    queryKey: megaQueryKeys.workspace(),
    queryFn: () => megaGet<Workspace>("workspace"),
  });
  const dirPaths = useMemo(() => [...loadedDirs], [loadedDirs]);
  const treeQueries = useQueries({
    queries: dirPaths.map((dirPath) => ({
      queryKey: megaQueryKeys.codeTree(dirPath || undefined),
      queryFn: () => megaGet<TreeNode[]>("code-tree", dirPath ? { path: dirPath } : undefined),
    })),
  });
  const childrenByPath = useMemo(() => {
    const children = new Map<string, readonly TreeNode[]>();
    dirPaths.forEach((dirPath, index) => {
      const data = treeQueries[index]?.data;
      if (data) children.set(dirPath, data);
    });
    return children;
  }, [dirPaths, treeQueries]);
  const mergedTree = useMemo(
    () => mergeTreeNodes(childrenByPath.get("") ?? [], childrenByPath),
    [childrenByPath],
  );
  const activeNode = findNode(mergedTree, fullPath);
  const isDirectory = activeNode?.kind === "directory";

  useEffect(() => {
    if (!isDirectory || !fullPath) return;
    setLoadedDirs((current) => (current.has(fullPath) ? current : new Set([...current, fullPath])));
  }, [fullPath, isDirectory]);

  const sourceQuery = useQuery({
    queryKey: megaQueryKeys.sourceFile(fullPath),
    queryFn: () => megaGet<SourceFilePayload>("source-file", { path: fullPath }),
    enabled: Boolean(fullPath) && activeNode?.kind === "file",
    retry: false,
  });
  const previewAvailable =
    sourceQuery.data?.language === "markdown" ||
    (fullPath.toLowerCase().endsWith(".md") && sourceQuery.isSuccess);
  const tab =
    requestedTab === "code"
      ? "code"
      : requestedTab === "preview" && previewAvailable
        ? "preview"
        : previewAvailable
          ? "preview"
          : "code";
  const readmeQuery = useQuery({
    queryKey: [...megaQueryKeys.readme(), fullPath] as const,
    queryFn: () => megaGet<ProseBlock[]>("readme", { path: fullPath }),
    enabled: Boolean(fullPath) && tab === "preview" && previewAvailable,
    retry: false,
  });
  const requiredTreePaths = new Set(["", ...ancestorPaths(fullPath)]);
  if (isDirectory && fullPath) requiredTreePaths.add(fullPath);
  const treePending = dirPaths.some(
    (dirPath, index) => requiredTreePaths.has(dirPath) && treeQueries[index]?.isPending,
  );
  const treeError = dirPaths.some(
    (dirPath, index) => requiredTreePaths.has(dirPath) && treeQueries[index]?.isError,
  );
  const sourceNotFound =
    sourceQuery.isError &&
    sourceQuery.error instanceof MegaApiError &&
    (sourceQuery.error.status === 404 || sourceQuery.error.code.includes("NOT_FOUND"));
  const dirChildren = isDirectory
    ? sortTreeNodesByKindThenName(childrenByPath.get(fullPath) ?? activeNode?.children ?? [])
    : [];
  const dirChildrenPending = isDirectory && Boolean(fullPath) && !childrenByPath.has(fullPath);
  const rootTreeReady =
    childrenByPath.has("") ||
    treeQueries.some((query, index) => dirPaths[index] === "" && query.isError);
  const pathUnresolved = Boolean(fullPath) && rootTreeReady && !activeNode && !treePending;

  const onSelect = useCallback(
    (node: FileTreeNode) => {
      if (currentContext.current !== contextKey) return;
      const href = `${workspaceBase}/code/${node.path.split("/").map(encodeURIComponent).join("/")}`;
      router.push(href);
    },
    [contextKey, router, workspaceBase],
  );
  const onDirectoryToggle = useCallback((path: string, expanded: boolean) => {
    rememberDirectory(path, expanded);
    if (!expanded) return;
    setLoadedDirs((current) => (current.has(path) ? current : new Set([...current, path])));
  }, []);

  if (treePending && mergedTree.length === 0) {
    return <CodePathLoading label={code.loading} />;
  }
  if (treeError) {
    return (
      <CodePathTreeError
        label={code.error}
        onRetry={() =>
          treeQueries.forEach((query) => {
            if (query.isError) void query.refetch();
          })
        }
        retryLabel={code.retry}
      />
    );
  }

  const contentState: CodePathContentState = (() => {
    if (isDirectory)
      return { children: dirChildren, kind: "directory", pending: dirChildrenPending };
    if (pathUnresolved || sourceNotFound) return { kind: "not-found" };
    if (sourceQuery.isError)
      return { kind: "source-error", onRetry: () => void sourceQuery.refetch() };
    if (sourceQuery.isPending || activeNode?.kind !== "file") return { kind: "file-loading" };
    if (tab === "preview" && readmeQuery.isPending) return { kind: "preview-loading" };
    if (tab === "preview" && readmeQuery.isError)
      return { kind: "preview-error", onRetry: () => void readmeQuery.refetch() };
    if (tab === "preview") return { blocks: readmeQuery.data ?? [], kind: "preview" };
    if (!sourceQuery.data) return { kind: "file-loading" };
    return {
      forcePlainText: shouldForcePlainText(sourceQuery.data),
      kind: "blob",
      sourceFile: sourceQuery.data,
    };
  })();

  return (
    <main
      data-mega-code="page"
      style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "100%" }}
    >
      <CodePathTree
        activePath={fullPath}
        branchName={workspaceQuery.data?.defaultBranch}
        nodes={mergedTree}
        onDirectoryToggle={onDirectoryToggle}
        onSelect={onSelect}
        treeAriaLabel={code.file.treeAriaLabel}
      />
      <section data-mega-code="content">
        <CodePathHeader
          breadcrumbAriaLabel={code.file.header.breadcrumbAriaLabel}
          codeLabel={code.file.header.tabs.code}
          isDirectory={isDirectory}
          onTabChange={(nextTab) => {
            if (currentContext.current === contextKey) router.replace(`?tab=${nextTab}`);
          }}
          pathSegments={pathSegments}
          previewAvailable={previewAvailable}
          previewLabel={code.file.header.tabs.preview}
          tabsAriaLabel={code.file.header.tabsAriaLabel}
          workspaceBase={workspaceBase}
          workspaceName={workspaceQuery.data?.name ?? "code"}
        />
        <CodePathContent fullPath={fullPath} state={contentState} workspaceBase={workspaceBase} />
      </section>
    </main>
  );
}
