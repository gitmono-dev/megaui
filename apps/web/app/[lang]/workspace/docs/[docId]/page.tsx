// megaui:apps/next-app/app/[lang]/workspace/docs/[docId]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-12 / DC-02 chrome / RO-01 / RO-04):
// - Three-column page (TOC | toolbar+article | meta) using library tokens.
// - Signed-in latest page mounts DocWriter; `?v=` and guests stay reader-only.
// - Paper chrome: shared detail-title, no editor card border, chips in toolbar.
// - Share stays fail-closed (dialog + copy link), not silent clipboard / default-open.
// - Linked / Unlinked references sit below the outliner and above comments.
// - Comments stay below the outliner (DC-03 composer). Snapshot restore via save.
// - No CE-102 side panel / live embed catalog / fixture tags.
"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { extractBlockSubtreeJSON, type Doc, type DocComment } from "@megaui/core";
import { MegaApiError, isMegaDocLinksQueryKey, megaGet, megaMutationInvalidations, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { BlockSidePanel, DocReferenceBadges, MegaContentReader } from "@megaui/ui/content/reader";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";

import { DocArticle } from "../components/doc-article";
import { DocComments } from "../components/doc-comments";
import { DocMetaSidebar } from "../components/doc-meta-sidebar";
import { DocReferences } from "../components/doc-references";
import { readingMinutes, tocFromBody, type TocEntry } from "../components/doc-outline";
import { DocShareDialog } from "../components/doc-share-dialog";
import { DocSplitPane } from "../components/doc-split-pane";
import { DocToc } from "../components/doc-toc";
import { DocToolbar } from "../components/doc-toolbar";
import { canMountDocWriter, DocWriter, type DocWriterChrome } from "../components/doc-writer";

const HEADING_SELECTOR =
  '[data-mega-block="h1"], [data-mega-block="h2"], [data-mega-block="h3"], .mega-doc-h1, .mega-doc-h2, .mega-doc-h3';

function megaErrorMessage(
  error: unknown,
  fallback: string,
  megaErrors: { badRequest: string; notFound: string; forbidden: string; conflict: string; internal: string },
): string {
  if (!(error instanceof MegaApiError)) return fallback;
  if (error.status === 403) return megaErrors.forbidden;
  if (error.status === 404) return megaErrors.notFound;
  if (error.status === 409) return megaErrors.conflict;
  if (error.status === 400) return megaErrors.badRequest;
  return megaErrors.internal;
}

interface BacklinkItem {
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  contextSummary: string | null;
  href: string;
  targetBlockId?: string;
}

type SidePanelState = { kind: "block" | "references"; blockId: string };

type OutlineNode = { blockId?: string; children?: OutlineNode[]; text?: string };

function blockCrumbs(body: string, blockId: string): { blockId: string; label: string }[] {
  try {
    const parsed = JSON.parse(body) as { root?: OutlineNode };
    const visit = (node: OutlineNode, path: { blockId: string; label: string }[]): { blockId: string; label: string }[] | null => {
      const own = node.blockId ? [...path, { blockId: node.blockId, label: node.children?.filter((child) => !child.blockId).map((child) => child.text ?? "").join("").trim().slice(0, 32) || "…" }] : path;
      if (node.blockId === blockId) return own;
      for (const child of node.children ?? []) {
        const result = visit(child, own);
        if (result) return result;
      }
      return null;
    };
    return visit(parsed.root ?? {}, []) ?? [];
  } catch {
    return [];
  }
}

interface UnlinkedItem {
  kind: "doc" | "issue" | "cl";
  targetId: string;
  targetTitle: string;
}

function DocDetailContent() {
  const params = useParams<{ docId: string }>();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  // megaui-only (FS-92): unknown search is not the latest writable document.
  if (params === null || searchParams === null || pathname === null) return <DocNavigationPending />;
  return <ReadyDocDetailContent params={params} searchParams={searchParams} pathname={pathname} />;
}

function DocNavigationPending() {
  return <main aria-busy="true" data-mega-docs="detail" style={{ background: MEGA_TOKENS.bg, height: "100%" }}>
    <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>…</p>
  </main>;
}

function ReadyDocDetailContent({ params, searchParams, pathname }: {
  params: { docId: string };
  searchParams: NonNullable<ReturnType<typeof useSearchParams>>;
  pathname: string;
}) {
  const router = useRouter();
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const detail = t.workspace.docDetail;
  const workspaceBase = `/${locale}/workspace`;
  const docId = decodeURIComponent(params?.docId ?? "");
  const contextKey = `${pathname}?${searchParams.toString()}`;
  const currentContext = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = null; };
  }, [contextKey]);
  const assertCurrentContext = () => {
    if (currentContext.current !== contextKey) throw new Error("Navigation context is unavailable");
  };
  const versionParam = searchParams.get("v");
  const versionNumber = versionParam ? Number(versionParam) : undefined;
  const [now] = useState(() => new Date().toISOString());
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [writerChrome, setWriterChrome] = useState<DocWriterChrome | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [sidePanel, setSidePanel] = useState<SidePanelState | null>(null);
  const [sidebarTarget, setSidebarTarget] = useState<HTMLDivElement | null>(null);
  const closeSidebar = useCallback(() => setSidePanel(null), []);
  const focusSidebar = useCallback((blockId: string) => setSidePanel({ kind: "block", blockId }), []);
  const [liveBody, setLiveBody] = useState<string | null>(null);
  const publicationFlushRef = useRef<(() => Promise<void>) | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSidePanel(null);
    setLiveBody(null);
  }, [docId]);

  const docQuery = useQuery({
    queryKey: megaQueryKeys.doc(docId),
    queryFn: () => megaGet<Doc>(["docs", docId]),
    enabled: Boolean(docId),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const backlinksQuery = useQuery({
    queryKey: megaQueryKeys.docBacklinks(docId),
    queryFn: () => megaGet<{ items: BacklinkItem[] }>(["docs", docId, "backlinks"]),
    enabled: Boolean(docId) && docQuery.isSuccess,
  });

  const unlinkedQuery = useQuery({
    queryKey: megaQueryKeys.docUnlinked(docId),
    queryFn: () => megaGet<{ items: UnlinkedItem[] }>(["docs", docId, "unlinked"]),
    enabled: Boolean(docId) && docQuery.isSuccess,
  });

  const commentsQuery = useQuery({
    queryKey: megaQueryKeys.docComments(docId),
    queryFn: () => megaGet<DocComment[]>(["docs", docId, "comments"]),
    enabled: Boolean(docId) && docQuery.isSuccess,
  });

  useEffect(() => {
    if (!docQuery.isSuccess || currentContext.current !== contextKey) return;
    void megaPost(["docs", docId, "view"]).catch(() => undefined);
  }, [docId, docQuery.isSuccess]);

  const snapshot = useMemo(() => {
    if (!docQuery.data || versionNumber == null || !Number.isFinite(versionNumber)) return undefined;
    return docQuery.data.versions.find((version) => version.version === versionNumber);
  }, [docQuery.data, versionNumber]);

  const readerBody = snapshot?.body ?? docQuery.data?.body;
  const referenceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of backlinksQuery.data?.items ?? []) {
      if (item.targetBlockId) counts[item.targetBlockId] = (counts[item.targetBlockId] ?? 0) + 1;
    }
    return counts;
  }, [backlinksQuery.data?.items]);
  const toc = useMemo(() => (readerBody ? tocFromBody(readerBody) : []), [readerBody]);
  const minutes = useMemo(() => (readerBody ? readingMinutes(readerBody) : 1), [readerBody]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || toc.length === 0) return;
    const onScroll = () => {
      const headings = [...(articleRef.current?.querySelectorAll<HTMLElement>(HEADING_SELECTOR) ?? [])];
      const boundary = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let current: number | null = toc[0]?.index ?? null;
      headings.forEach((heading, order) => {
        if (heading.getBoundingClientRect().top <= boundary) current = toc[order]?.index ?? current;
      });
      setActiveIndex(current);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [toc]);

  const scrollToEntry = (entry: TocEntry) => {
    const headings = [...(articleRef.current?.querySelectorAll<HTMLElement>(HEADING_SELECTOR) ?? [])];
    const order = toc.findIndex((candidate) => candidate.index === entry.index);
    headings[order]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const starMutation = useMutation({
    mutationFn: () => {
      assertCurrentContext();
      return megaPost<Doc>(["docs", docId, "toggle-star"]);
    },
    onSuccess: (doc) => {
      queryClient.setQueryData(megaQueryKeys.doc(docId), doc);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docs() });
    },
  });

  const renameMutation = useMutation({
    mutationFn: (title: string) => {
      assertCurrentContext();
      return megaPost<Doc>(["docs", docId, "rename"], { title });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(megaQueryKeys.doc(docId), next);
      for (const key of megaMutationInvalidations.docRename(docId)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      void queryClient.invalidateQueries({
        predicate: (query) => isMegaDocLinksQueryKey(query.queryKey),
      });
    },
  });

  const publicationMutation = useMutation({
    mutationFn: async (publish: boolean) => {
      assertCurrentContext();
      if (publish) {
        if (!publicationFlushRef.current) throw new Error("Editor is not ready for publication");
        await publicationFlushRef.current();
      }
      return megaPost<Doc>(["docs", docId, publish ? "publish" : "unpublish"]);
    },
    onSuccess: (next, publish) => {
      queryClient.setQueryData(megaQueryKeys.doc(docId), next);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docs() });
      setToast({ tone: "success", message: publish ? detail.publication.published : detail.publication.unpublished });
    },
    onError: (error, publish) => {
      const failure = publish ? detail.publication.publishFailed : detail.publication.unpublishFailed;
      setToast({ tone: "error", message: megaErrorMessage(error, failure, { ...t.errors.mega, internal: failure }) });
    },
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) => {
      assertCurrentContext();
      return megaPost<DocComment>(["docs", docId, "comments"], { body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docComments(docId) });
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.doc(docId) });
      setCommentDraft("");
      setToast({ tone: "success", message: detail.comments.commentAdded });
    },
    onError: (error) => {
      setToast({
        tone: "error",
        message: megaErrorMessage(error, detail.comments.actionFailed, t.errors.mega),
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (origin: { body: string; docId: string; contextKey: string; pathname: string; versionNumber: number | undefined }) => {
      if (currentContext.current !== origin.contextKey) throw new Error("Navigation context is unavailable");
      const doc = await megaPost<Doc>(["docs", origin.docId, "save"], {
        body: origin.body,
        summary: `Restored v${origin.versionNumber ?? ""}`,
      });
      // React Query may replace pending mutation options on a later render.
      // Preserve the action's origin both before admission and after completion.
      return { doc, origin };
    },
    onSuccess: ({ doc, origin }) => {
      queryClient.setQueryData(megaQueryKeys.doc(origin.docId), doc);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docs() });
      setToast({ tone: "success", message: detail.restoreSuccess });
      if (currentContext.current === origin.contextKey) router.replace(origin.pathname);
    },
    onError: (error) => {
      const message =
        error instanceof MegaApiError && error.status === 403
          ? t.errors.mega.forbidden
          : detail.restoreFailed;
      setToast({ tone: "error", message });
    },
  });

  const notFound =
    !docId ||
    (docQuery.isError && docQuery.error instanceof MegaApiError && docQuery.error.status === 404);

  if (notFound) {
    return (
      <main data-mega-docs="detail" style={{ background: MEGA_TOKENS.bg, height: "100%" }}>
        <div data-mega-docs="not-found" role="alert" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}>
          <h1 style={{ color: MEGA_TOKENS.text, fontSize: "calc(var(--mega-density-font-size) + 4px)", fontWeight: 700, margin: 0 }}>
            {detail.notFoundTitle}
          </h1>
          <p style={{ color: MEGA_TOKENS.muted }}>{detail.notFoundBody}</p>
          <Link href={`${workspaceBase}/docs`} style={{ color: MEGA_TOKENS.accent, textDecoration: "none" }}>
            {detail.backToDocs}
          </Link>
        </div>
      </main>
    );
  }

  if (docQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-docs="detail" style={{ background: MEGA_TOKENS.bg, height: "100%" }}>
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{detail.loading}</p>
      </main>
    );
  }

  if (docQuery.isError) {
    return (
      <main data-mega-docs="detail" style={{ background: MEGA_TOKENS.bg, height: "100%" }}>
        <div role="alert" style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{detail.error}</p>
          <button data-mega-docs="retry" onClick={() => void docQuery.refetch()} type="button">
            {detail.retry}
          </button>
        </div>
      </main>
    );
  }

  const doc = docQuery.data;
  const canWrite = Boolean(session?.user?.id) && doc.canEdit !== false;
  const canWritePage = canWrite && canMountDocWriter(session?.user?.id, searchParams.has("v"));
  const viewingSnapshot = searchParams.has("v") && snapshot != null;
  const viewedDoc = snapshot?.body ? { ...doc, body: snapshot.body } : doc;
  const panelBody = canWritePage ? liveBody ?? doc.body : viewedDoc.body;
  const panelSnapshot = sidePanel ? extractBlockSubtreeJSON(panelBody, sidePanel.blockId) : null;
  const panelSources = (backlinksQuery.data?.items ?? []).filter((item) => item.targetBlockId === sidePanel?.blockId);
  const referenceBadges = (
    <DocReferenceBadges
      articleRef={articleRef}
      counts={referenceCounts}
      label={t.workspace.docEdit.sidePanel.referenceCount}
      onOpen={(blockId) => setSidePanel({ kind: "references", blockId })}
    />
  );
  const editHref = `${workspaceBase}/docs/${encodeURIComponent(doc.id)}`;
  const sidebar = sidePanel ? (
          <BlockSidePanel
            collapseOnBlur={false}
            crumbs={blockCrumbs(panelBody, sidePanel.blockId)}
            labels={{
              ariaLabel: t.workspace.docEdit.sidePanel.ariaLabel,
              breadcrumbAriaLabel: t.workspace.docEdit.sidePanel.breadcrumbAriaLabel,
              close: t.workspace.docEdit.sidePanel.close,
              invalid: t.workspace.docEdit.sidePanel.invalid,
              pageCrumb: doc.title,
            }}
            onClose={closeSidebar}
            onNavigate={(blockId) => setSidePanel(blockId ? { kind: "block", blockId } : null)}
            valid={Boolean(panelSnapshot)}
          >
            {sidePanel.kind === "block" && panelSnapshot ? (
              canWritePage ? (
                <div data-mega-docs="sidebar-editor" data-mega-content="outliner" ref={setSidebarTarget} style={{ position: "relative" }} />
              ) : <MegaContentReader stateJSON={panelSnapshot} workspaceBase={workspaceBase} />
            ) : null}
            {sidePanel.kind === "references" ? (
              <section data-mega-docs="block-reference-sources">
                <h2 style={{ fontSize: 15, marginTop: 0 }}>{detail.meta.backlinks.title} ({panelSources.length})</h2>
                {panelSources.length === 0 ? <p>{detail.meta.backlinks.empty}</p> : null}
                {panelSources.map((item, index) => (
                  <p key={`${item.sourceType}:${item.sourceId}:${index}`}>
                    <Link href={`${workspaceBase}${item.href.startsWith("/") ? item.href : `/${item.href}`}`}>{item.sourceTitle}</Link>
                    {item.contextSummary ? <span style={{ display: "block" }}>{item.contextSummary}</span> : null}
                  </p>
                ))}
              </section>
            ) : null}
          </BlockSidePanel>
  ) : undefined;

  return (
    <main
      data-mega-docs={canWritePage ? "page-write" : "detail"}
      style={{ background: MEGA_TOKENS.bg, display: "flex", height: "100%", minHeight: 0 }}
    >
      <DocToc
        activeIndex={activeIndex}
        entries={toc}
        labels={detail.toc}
        minutes={minutes}
        onSelect={scrollToEntry}
        versionCount={doc.versions.length}
      />

      <DocSplitPane panel={sidebar} resizeLabel={t.workspace.docEdit.sidePanel.resize}>
      <div style={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0, minWidth: 0 }}>
        {toast ? (
          <div
            data-mega-docs="toast"
            data-mega-toast={toast.tone}
            role="status"
            style={{
              background: toast.tone === "error" ? MEGA_TOKENS.danger : MEGA_TOKENS.success,
              color: MEGA_TOKENS.accentForeground,
              fontSize: "calc(var(--mega-density-font-size) - 1px)",
              padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
            }}
          >
            {toast.message}
          </div>
        ) : null}

        <DocToolbar
          crumbTag={doc.tags[0]?.name}
          docsHref={`${workspaceBase}/docs`}
          editHref={editHref}
          isStarred={doc.starred}
          labels={{
            breadcrumbDocs: detail.toolbar.breadcrumbDocs,
            deferredTooltip: detail.toolbar.deferredTooltip,
            edit: detail.toolbar.edit,
            exportDoc: detail.toolbar.exportDoc,
            history: detail.toolbar.history,
            rename: detail.toolbar.rename,
            renameAriaLabel: detail.toolbar.renameAriaLabel,
            renameCancel: detail.toolbar.renameCancel,
            renameSave: detail.toolbar.renameSave,
            share: detail.toolbar.share,
            starAriaLabel: detail.metaEditor.starAriaLabel,
            unstarAriaLabel: detail.metaEditor.unstarAriaLabel,
          }}
          onRename={
            canWrite
              ? async (title) => {
                  await renameMutation.mutateAsync(title);
                }
              : undefined
          }
          publication={canWritePage && doc.canEdit === true ? {
            label: doc.status === "published"
              ? publicationMutation.isPending ? detail.publication.unpublishing : detail.publication.unpublish
              : publicationMutation.isPending ? detail.publication.publishing : detail.publication.publish,
            busy: publicationMutation.isPending,
            disabled: publicationMutation.isPending || (doc.status !== "published" && !writerChrome?.canPublish),
            onClick: () => publicationMutation.mutate(doc.status !== "published"),
          } : undefined}
          onShare={() => setShareOpen(true)}
          onStar={() => starMutation.mutate()}
          showEditEntry={!canWritePage && canWrite}
          starring={starMutation.isPending}
          title={doc.title}
          writerChrome={canWritePage ? writerChrome : null}
        />

        {viewingSnapshot ? (
          <div
            data-mega-docs="snapshot-banner"
            role="status"
            style={{
              alignItems: "center",
              background: `color-mix(in srgb, ${MEGA_TOKENS.warning} 9%, transparent)`,
              borderBottom: `1px solid ${MEGA_TOKENS.border}`,
              display: "flex",
              flexWrap: "wrap",
              gap: MEGA_SPACING_TOKENS[8],
              padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
            }}
          >
            <span style={{ color: MEGA_TOKENS.text, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
              {detail.snapshotBanner.replace("{version}", String(versionNumber))}
            </span>
            <Link
              data-mega-docs="back-latest"
              href={pathname}
              style={{ color: MEGA_TOKENS.accent, fontWeight: 600, textDecoration: "none" }}
            >
              {detail.backToLatest}
            </Link>
            {canWrite && snapshot?.body ? (
              <button
                data-mega-docs="restore"
                disabled={restoreMutation.isPending}
                onClick={() => {
                  if (snapshot.body) restoreMutation.mutate({ body: snapshot.body, docId, contextKey, pathname, versionNumber });
                }}
                style={{
                  background: "transparent",
                  border: `1px solid ${MEGA_TOKENS.border}`,
                  borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
                  color: MEGA_TOKENS.text,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "calc(var(--mega-density-font-size) - 1px)",
                  padding: `${MEGA_SPACING_TOKENS[3]} ${MEGA_SPACING_TOKENS[8]}`,
                }}
                type="button"
              >
                {restoreMutation.isPending ? detail.restoringVersion : detail.restoreVersion}
              </button>
            ) : null}
          </div>
        ) : null}

        <div ref={scrollRef} style={{ background: MEGA_TOKENS.subtle, flex: 1, minHeight: 0, overflow: "auto" }}>
          {canWritePage ? (
            <DocArticle
              articleRef={articleRef}
              doc={doc}
              labels={detail.article}
              locale={locale}
              now={now}
              referenceBadges={referenceBadges}
              variant="writer"
              workspaceBase={workspaceBase}
            >
              <DocWriter
                conflictMessage={t.workspace.docs.apiErrors.MEGA_CONFLICT}
                doc={doc}
                forbiddenError={t.errors.mega.forbidden}
                genericError={t.workspace.docs.error}
                labels={{
                  autoSaveHint: t.workspace.docEdit.autoSaveHint,
                  collabConnecting: t.workspace.docEdit.collabConnecting,
                  collabLive: t.workspace.docEdit.collabLive,
                  collabOffline: t.workspace.docEdit.collabOffline,
                  collabReadonly: t.workspace.docEdit.collabReadonly,
                  placeholder: t.workspace.docEdit.placeholder,
                  saved: t.workspace.docEdit.saved,
                  saving: t.workspace.docEdit.saving,
                }}
                sidebar={sidebarTarget && sidePanel?.kind === "block" && panelSnapshot ? {
                  target: sidebarTarget, blockId: sidePanel.blockId, onClose: closeSidebar, onFocus: focusSidebar,
                } : undefined}
                publicationFlushRef={publicationFlushRef}
                onChromeChange={setWriterChrome}
                onBodyChange={setLiveBody}
                onOpenBlock={(blockId) => setSidePanel({ kind: "block", blockId })}
                onToast={setToast}
              />
            </DocArticle>
          ) : (
            <DocArticle
              articleRef={articleRef}
              doc={viewedDoc}
              labels={detail.article}
              locale={locale}
              now={now}
              referenceBadges={referenceBadges}
              variant="reader"
              workspaceBase={workspaceBase}
            />
          )}
          <DocReferences
            labels={{
              empty: detail.meta.backlinks.empty,
              title: detail.meta.backlinks.title,
              typeCl: detail.meta.backlinks.typeCl,
              typeDoc: detail.meta.backlinks.typeDoc,
              typeIssue: detail.meta.backlinks.typeIssue,
              typeOther: detail.meta.backlinks.typeOther,
              unlinkedEmpty: detail.meta.backlinks.unlinkedEmpty,
              unlinkedTitle: detail.meta.backlinks.unlinkedTitle,
            }}
            linked={Array.isArray(backlinksQuery.data?.items) ? backlinksQuery.data.items : []}
            linkedPending={backlinksQuery.isPending}
            loadingLabel={detail.loading}
            unlinked={Array.isArray(unlinkedQuery.data?.items) ? unlinkedQuery.data.items : []}
            unlinkedPending={unlinkedQuery.isPending}
            workspaceBase={workspaceBase}
          />
          <DocComments
            authorId={doc.author.id}
            comments={commentsQuery.data}
            draft={commentDraft}
            labels={detail.comments}
            loading={commentsQuery.isPending}
            loadingLabel={detail.loading}
            locale={locale}
            now={now}
            onDraftChange={setCommentDraft}
            onSubmit={() => commentMutation.mutate(commentDraft.trim())}
            showComposer={canWritePage}
            submitting={commentMutation.isPending}
          />
        </div>
      </div>

      </DocSplitPane>
      {sidePanel ? null : <DocMetaSidebar
        activeVersion={snapshot?.version}
        doc={doc}
        labels={{
          collaborators: detail.meta.collaborators,
          linked: detail.meta.linked,
          none: detail.meta.none,
          recentVersions: detail.meta.recentVersions,
          roleAuthor: detail.meta.roleAuthor,
          roleEditor: detail.meta.roleEditor,
          tags: detail.meta.tags,
          versionAriaLabel: detail.versions.versionAriaLabel,
          versionLine: detail.versions.versionLine,
          versionsTitle: detail.versions.title,
        }}
        locale={locale}
        now={now}
        pathname={pathname}
        workspaceBase={workspaceBase}
      />}

      {shareOpen ? (
        <DocShareDialog
          collaborators={doc.collaborators}
          labels={detail.toolbar.shareDialog}
          onClose={() => setShareOpen(false)}
          onCopied={(ok) =>
            setToast({
              tone: ok ? "success" : "error",
              message: ok ? detail.toolbar.shareDialog.copied : detail.toolbar.shareDialog.copyFailed,
            })
          }
        />
      ) : null}
    </main>
  );
}

export default function DocDetailPage() {
  return (
    <Suspense
      fallback={<DocNavigationPending />}
    >
      <DocDetailContent />
    </Suspense>
  );
}
