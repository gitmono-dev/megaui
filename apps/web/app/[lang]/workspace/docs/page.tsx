// megaui:apps/next-app/app/[lang]/workspace/docs/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-12):
// - Library chrome matches v6 / DC-01 (sidebar + masonry cards + ⌘F + sort).
// - Folder/tag catalogs are derived from live docs (no DOC_FOLDERS / DOC_TAGS fixtures).
// - Create still opens the reader, not /edit.
// - Tasks / Calendar / Imagine / Shared and Wall / List views stay deferred.
"use client";

import { WorkspaceLoading } from "../components/workspace-loading";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { Doc } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

import {
  catalogsFromDocs,
  filterDocs,
  sortDocs,
  type DocsScope,
  type DocsSort,
} from "./components/docs-filter";
import { DocsGrid } from "./components/docs-grid";
import { DocsHeader } from "./components/docs-header";
import { DocsSidebar } from "./components/docs-sidebar";
import { NewDocDialog } from "./components/new-doc-dialog";

function scopeFromParams(searchParams: URLSearchParams | null): DocsScope {
  const filter = searchParams?.get("filter");
  const folder = searchParams?.get("folder");
  const tag = searchParams?.get("tag");
  if (filter === "starred") return { kind: "starred" };
  if (folder) return { kind: "folder", folderId: folder };
  if (tag) return { kind: "tag", tagId: tag };
  return { kind: "all" };
}

function DocsLibraryContent() {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const docsText = t.workspace.docs;
  const workspaceBase = `/${locale}/workspace`;
  const [now] = useState(() => new Date().toISOString());
  const [dialogOpen, setDialogOpen] = useState(searchParams?.get("new") === "1");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scope = scopeFromParams(searchParams);
  const search = searchParams?.get("q") ?? "";
  const sort: DocsSort = searchParams?.get("sort") === "title" ? "title" : "updated";

  const setParams = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "") params.delete(key);
      else params.set(key, value);
    }
    params.delete("new");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const setScope = (next: DocsScope) => {
    switch (next.kind) {
      case "all":
        setParams({ filter: null, folder: null, tag: null });
        return;
      case "starred":
        setParams({ filter: "starred", folder: null, tag: null });
        return;
      case "folder":
        setParams({ filter: null, folder: next.folderId, tag: null });
        return;
      case "tag":
        setParams({ filter: null, folder: null, tag: next.tagId });
        return;
      default: {
        const exhaustive: never = next;
        return exhaustive;
      }
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, []);

  const listQuery = useQuery({
    queryKey: megaQueryKeys.docs(),
    queryFn: () => megaGet<Doc[]>("docs"),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const starMutation = useMutation({
    mutationFn: (docId: string) => megaPost<Doc>(["docs", docId, "toggle-star"]),
    onSuccess: (doc) => {
      queryClient.setQueryData<Doc[]>(megaQueryKeys.docs(), (current) =>
        current?.map((row) => (row.id === doc.id ? doc : row)) ?? current,
      );
      queryClient.setQueryData(megaQueryKeys.doc(doc.id), doc);
    },
  });

  const createMutation = useMutation({
    mutationFn: (input: { folderId?: string; title: string }) => megaPost<Doc>("docs", input),
    onSuccess: (doc) => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docs() });
      setDialogOpen(false);
      router.push(`${workspaceBase}/docs/${encodeURIComponent(doc.id)}`);
    },
  });

  const createError = createMutation.error instanceof MegaApiError && createMutation.error.code === "TITLE_CONFLICT"
    ? docsText.apiErrors.TITLE_CONFLICT
    : null;

  const docs = listQuery.data ?? [];
  const catalogs = useMemo(
    () => catalogsFromDocs(docs, docsText.sidebar.unsorted),
    [docs, docsText.sidebar.unsorted],
  );
  const rows = useMemo(() => sortDocs(filterDocs(docs, scope, search), sort), [docs, scope, search, sort]);

  const scopeTitle = (() => {
    switch (scope.kind) {
      case "all":
        return docsText.header.allTitle;
      case "starred":
        return docsText.sidebar.starred;
      case "folder":
        return catalogs.folders.find((folder) => folder.id === scope.folderId)?.name ?? docsText.header.allTitle;
      case "tag":
        return catalogs.tags.find((tag) => tag.id === scope.tagId)?.name ?? docsText.header.allTitle;
      default: {
        const exhaustive: never = scope;
        return exhaustive;
      }
    }
  })();

  const openDoc = (doc: Doc) => {
    router.push(`${workspaceBase}/docs/${encodeURIComponent(doc.id)}`);
  };

  const emptyLabel = scope.kind === "starred" ? docsText.sidebar.starredEmpty : docsText.empty;

  return (
    <div
      data-mega-docs="page"
      ref={containerRef}
      style={{ display: "flex", height: "100%", minHeight: 0 }}
      tabIndex={-1}
    >
      <DocsSidebar
        docs={docs}
        folders={catalogs.folders}
        labels={docsText.sidebar}
        onNewDoc={() => setDialogOpen(true)}
        onOpenDoc={openDoc}
        onScopeChange={setScope}
        scope={scope}
        tags={catalogs.tags}
      />
      <div
        style={{
          background: MEGA_TOKENS.subtle,
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <DocsHeader
          authorCount={new Set(docs.map((doc) => doc.author.id)).size}
          docCount={rows.length}
          folderCount={new Set(docs.map((doc) => doc.folderId).filter(Boolean)).size}
          labels={docsText.header}
          onNewDoc={() => setDialogOpen(true)}
          onSearchChange={(value) => setParams({ q: value })}
          onSortToggle={() => setParams({ sort: sort === "updated" ? "title" : null })}
          search={search}
          searchInputRef={searchInputRef}
          sort={sort}
          title={scopeTitle}
        />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.5) calc(${MEGA_SPACING_TOKENS[8]} * 3) calc(${MEGA_SPACING_TOKENS[8]} * 5)`,
          }}
        >
          {listQuery.isPending ? (
            <WorkspaceLoading label={docsText.loading} />
          ) : listQuery.isError ? (
            <div role="alert" style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
              <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{docsText.error}</p>
              <button data-mega-docs="retry" onClick={() => void listQuery.refetch()} type="button">
                {docsText.retry}
              </button>
            </div>
          ) : (
            <DocsGrid
              docs={rows}
              emptyLabel={emptyLabel}
              labels={docsText.card}
              locale={locale}
              now={now}
              onOpen={openDoc}
              onToggleStar={(doc) => starMutation.mutate(doc.id)}
            />
          )}
        </div>
      </div>

      <NewDocDialog
        errorMessage={createError}
        folders={catalogs.folders}
        labels={docsText.newDialog}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            createMutation.reset();
            if (searchParams?.get("new")) setParams({ new: null });
          }
        }}
        onSubmit={(input) => createMutation.mutate(input)}
        open={dialogOpen}
        submitting={createMutation.isPending}
      />
    </div>
  );
}

export default function DocsPage() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<main aria-busy="true" data-mega-docs="page"><WorkspaceLoading label={t.workspace.docs.loading} variant="page" /></main>}>
      <DocsLibraryContent />
    </Suspense>
  );
}
