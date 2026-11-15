// megaui-only (FIX-RO-03): Docs consumes the existing ACL-protected BFF
// contracts here; the reusable Lexical plugins remain transport-agnostic.
"use client";

import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  BlockCollapsePlugin,
  BlockContextMenuPlugin,
  BlockEmbedPastePlugin,
  BlockFocusPlugin,
  BlockRefsPlugin,
  BlockReferenceSyntaxPlugin,
  CompletedPageReferencesPlugin,
  EmbedsPlugin,
  ImagePlugin,
  QuickCommandsPlugin,
  TodoCheckboxPlugin,
  TableControlsPlugin,
  TrailingMediaBlockPlugin,
  WikilinksPlugin,
  type BlockRefCandidate,
  type BlockRefValue,
  type CompletedPageReference,
  type EmbedCandidate,
  type WikilinkCandidate,
} from "@megaui/ui/content/editor";
import { megaGet, megaPost } from "@megaui/ui/query";

import { useTranslation } from "@/hooks/use-translation";

interface ResolveOrCreateDocResult {
  created: boolean;
  targetId: string;
}

interface WorkspaceDocBodyHit {
  blockId: string;
  kind: "doc";
  snippet: string;
  sourceId: string;
  title: string;
}

interface WorkspaceSearchResult {
  body: {
    docs: readonly WorkspaceDocBodyHit[];
  };
}

export interface DocRoamShortcutsProps {
  readonly onReferenceCreateError: (error: unknown) => void;
  readonly onOpenBlock?: (blockId: string) => void;
  readonly focusOverride?: { blockId: string; onFocus: (blockId: string) => void; onExit: () => void };
}

function workspaceBaseFromPath(pathname: string): string {
  const docsPathStart = pathname.indexOf("/docs/");
  return docsPathStart === -1 ? "/workspace" : pathname.slice(0, docsPathStart);
}

function rankTitleCandidates(candidates: readonly WikilinkCandidate[], query: string): readonly WikilinkCandidate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return candidates;
  return candidates
    .filter((candidate) => {
      const titleMatches = candidate.targetTitle.toLocaleLowerCase().includes(normalizedQuery);
      const idMatches = candidate.targetId?.toLocaleLowerCase().includes(normalizedQuery) ?? false;
      return titleMatches || idMatches;
    })
    .sort((left, right) => {
      const leftStarts = left.targetTitle.toLocaleLowerCase().startsWith(normalizedQuery);
      const rightStarts = right.targetTitle.toLocaleLowerCase().startsWith(normalizedQuery);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.targetTitle.localeCompare(right.targetTitle);
    });
}

function blockCandidateFromHit(hit: WorkspaceDocBodyHit): BlockRefCandidate {
  const label = hit.snippet || hit.title;
  return {
    detail: `${hit.title} › ${label}`,
    label,
    sourcePath: hit.title,
    targetBlockId: hit.blockId,
    targetDocId: hit.sourceId,
  };
}

/** Adds the four write-only Roam-style triggers to the document Lexical tree. */
export function DocRoamShortcuts(props: DocRoamShortcutsProps): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // megaui-only (FS-92): never infer a writable workspace from unknown navigation.
  if (pathname === null || searchParams === null) return null;
  return <ReadyDocRoamShortcuts {...props} pathname={pathname} searchParams={searchParams} />;
}

function ReadyDocRoamShortcuts({ onReferenceCreateError, onOpenBlock, focusOverride, pathname, searchParams }: DocRoamShortcutsProps & {
  pathname: string;
  searchParams: NonNullable<ReturnType<typeof useSearchParams>>;
}): ReactNode {
  const { t } = useTranslation();
  const router = useRouter();
  const contextKey = `${pathname}?${searchParams.toString()}`;
  const currentContext = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = null; };
  }, [contextKey]);
  const titleIndexPromiseRef = useRef<Promise<readonly WikilinkCandidate[]> | null>(null);
  const workspaceBase = workspaceBaseFromPath(pathname);
  const currentDocId = decodeURIComponent(pathname.split("/docs/")[1] ?? "");
  const blockFocusId = searchParams.get("block");

  const searchTitleIndex = useCallback(async (query: string): Promise<readonly WikilinkCandidate[]> => {
    if (!titleIndexPromiseRef.current) {
      titleIndexPromiseRef.current = megaGet<readonly WikilinkCandidate[]>(["docs", "title-index"]);
    }
    return rankTitleCandidates(await titleIndexPromiseRef.current, query);
  }, []);

  const createPage = useCallback(async (title: string): Promise<CompletedPageReference> => {
    if (currentContext.current !== contextKey) throw new Error("Navigation context is unavailable");
    const result = await megaPost<ResolveOrCreateDocResult>(["docs", "resolve-or-create"], { title });
    titleIndexPromiseRef.current = null;
    return { kind: "doc", targetId: result.targetId, targetTitle: title };
  }, [contextKey]);

  const searchBlocks = useCallback(async (query: string): Promise<readonly BlockRefCandidate[]> => {
    const result = await megaGet<WorkspaceSearchResult>(["search"], { q: query });
    return result.body.docs.map(blockCandidateFromHit);
  }, []);

  const resolveBlockReference = useCallback((blockId: string, docHint: string, exactDoc: boolean) =>
    megaGet<BlockRefValue>(["blocks", "resolve"], { block: blockId, doc: docHint, exact: String(exactDoc) }), []);

  const searchEmbeds = useCallback(async (query: string): Promise<readonly EmbedCandidate[]> => {
    const [pages, blocks] = await Promise.all([searchTitleIndex(query), searchBlocks(query)]);
    return [
      ...pages.flatMap((page): EmbedCandidate[] => page.kind === "doc" && page.targetId
        ? [{ kind: "page", targetDocId: page.targetId, label: page.targetTitle, detail: page.targetTitle }]
        : []),
      ...blocks.map((block): EmbedCandidate => ({
        kind: "block",
        targetDocId: block.targetDocId,
        targetBlockId: block.targetBlockId,
        label: block.label,
        detail: block.detail,
      })),
    ];
  }, [searchBlocks, searchTitleIndex]);

  const uploadImage = useCallback(async (file: File): Promise<string> => {
    if (currentContext.current !== contextKey) throw new Error("Navigation context is unavailable");
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/upload?purpose=attachment", { method: "POST", body: form });
    if (!response.ok) throw new Error(`Image upload failed (${response.status})`);
    const result = await response.json() as { data?: { url?: string } };
    if (!result.data?.url) throw new Error("Image upload returned no URL");
    return result.data.url;
  }, [contextKey]);

  const navigateToPage = useCallback(
    (targetId: string) => {
      if (currentContext.current !== contextKey) return;
      router.push(`${workspaceBase}/docs/${encodeURIComponent(targetId)}`);
    },
    [contextKey, router, workspaceBase],
  );

  const focusBlock = useCallback((blockId: string) => {
    if (currentContext.current !== contextKey) return;
    if (focusOverride) { focusOverride.onFocus(blockId); return; }
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("block", blockId);
    router.push(`${pathname}?${nextParams.toString()}`, { scroll: false });
  }, [contextKey, focusOverride, pathname, router, searchParams]);

  const exitBlockFocus = useCallback(() => {
    if (currentContext.current !== contextKey) return;
    if (focusOverride) { focusOverride.onExit(); return; }
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("block");
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [contextKey, focusOverride, pathname, router, searchParams]);

  return (
    <>
      <BlockFocusPlugin blockId={focusOverride?.blockId ?? blockFocusId} onExit={exitBlockFocus} />
      <TrailingMediaBlockPlugin />
      <BlockCollapsePlugin labels={t.workspace.docEdit.blockCollapse} />
      <TodoCheckboxPlugin labels={t.workspace.docEdit.todoCheckbox} />
      <BlockContextMenuPlugin labels={t.workspace.docEdit.blockContextMenu} onFocusBlock={focusBlock} onOpenInSidebar={onOpenBlock} sourceDocId={currentDocId} />
      <BlockEmbedPastePlugin currentDocId={currentDocId} />
      <BlockReferenceSyntaxPlugin currentDocId={currentDocId} resolve={resolveBlockReference} />
      <QuickCommandsPlugin labels={t.workspace.docEdit.quickCommands} />
      <ImagePlugin labels={t.workspace.docEdit.images} onError={onReferenceCreateError} upload={uploadImage} />
      <TableControlsPlugin labels={t.workspace.docEdit.tableControls} />
      <WikilinksPlugin createPage={createPage} labels={t.workspace.docEdit.wikilinks} search={searchTitleIndex} />
      <BlockRefsPlugin labels={t.workspace.docEdit.blockRefs} search={searchBlocks} />
      <EmbedsPlugin labels={t.workspace.docEdit.embeds} search={searchEmbeds} />
      <CompletedPageReferencesPlugin createPage={createPage} onCreateError={onReferenceCreateError} onNavigate={navigateToPage} />
    </>
  );
}
