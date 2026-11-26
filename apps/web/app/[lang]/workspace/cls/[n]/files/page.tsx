"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { clFileForRange, isCLReference, parseRevRange, type CL, type CLFile } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";

import { WorkspaceLoading } from "@/app/[lang]/workspace/components/workspace-loading";
import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { ReviewDiffs } from "./review-diffs";
import { filterChangedFiles, ReviewFileTree, ReviewToolbar } from "./review-navigation";
import { useLocalViewed } from "./use-local-viewed";
import styles from "./files.module.css";

const NO_FILES: readonly CLFile[] = [];

// Keep the review controls unmounted until the route and its query are both available.
export default function CLFilesPage() {
  const params = useParams<{ n: string }>();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  if (!params || !searchParams) {
    return <section aria-busy="true" data-mega-cls="files"><WorkspaceLoading label={t.workspace.clDetail.files.loading} variant="files" /></section>;
  }
  return <ReadyCLFilesPage key={params.n} routeId={params.n} searchParams={searchParams} />;
}

function updateReviewQuery(key: "range" | "file", value: string) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

function ReadyCLFilesPage({ routeId, searchParams }: {
  routeId: string;
  searchParams: NonNullable<ReturnType<typeof useSearchParams>>;
}) {
  const { t } = useTranslation();
  const text = t.workspace.clDetail.files;
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const contextKey = `${routeId}?${searchParams.toString()}`;
  const currentContext = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = null; };
  }, [contextKey]);

  const clQuery = useQuery({
    queryKey: megaQueryKeys.cl(routeId),
    queryFn: () => megaGet<CL>(["cls", routeId]),
    enabled: isCLReference(routeId),
    staleTime: 10_000,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });
  const cl = clQuery.data;
  const rangeParam = searchParams.get("range");
  const fileParam = searchParams.get("file");
  const range = useMemo(() => cl && parseRevRange(rangeParam, cl.revisions), [cl, rangeParam]);
  const selectedRange = range ? `${range.from}..${range.to}` : "";
  const availableRanges = useMemo(() => {
    const choices = new Set<string>();
    for (const file of cl?.files ?? NO_FILES) {
      for (const key of Object.keys(file.rangePatches ?? {})) choices.add(key);
    }
    if (selectedRange) choices.add(selectedRange);
    return [...choices].filter((key) => cl && parseRevRange(key, cl.revisions)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }, [cl, selectedRange]);

  // Mega2 provides the patch but has no per-reviewer file receipt. Keep its progress
  // separate for every signed-in viewer and revision. Database-backed CLs use the BFF.
  const localProgress = Boolean(cl?.id?.startsWith("cl_m2_"));
  const actorId = session?.user?.id;
  const head = cl?.revisions?.[0]?.sha;
  const scope = localProgress && actorId && cl && head
    ? { actorId, publicId: cl.publicId, revision: head, range: selectedRange }
    : undefined;
  const { paths, setViewed } = useLocalViewed(scope);
  const [localError, setLocalError] = useState(false);
  const [pendingReceipt, setPendingReceipt] = useState<{ path: string; viewed: boolean } | null>(null);
  const scopedFiles = useMemo(() => {
    const source = cl?.files ?? NO_FILES;
    return range ? source.map((file) => clFileForRange(file, range)) : source;
  }, [cl?.files, range]);
  const files = useMemo(() => {
    if (localProgress) return scopedFiles.map((file) => paths.has(file.path) ? { ...file, viewed: true } : file);
    if (!pendingReceipt) return scopedFiles;
    return scopedFiles.map((file) => file.path === pendingReceipt.path ? { ...file, viewed: pendingReceipt.viewed } : file);
  }, [scopedFiles, localProgress, paths, pendingReceipt]);
  const [filter, setFilter] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [jumpTarget, setJumpTarget] = useState<{ path: string }>();
  useLayoutEffect(() => {
    setJumpTarget(fileParam ? { path: fileParam } : undefined);
  }, [fileParam]);
  const filtered = useMemo(() => filterChangedFiles(files, filter), [files, filter]);
  const activeFile = filtered.find((file) => file.path === fileParam) ?? filtered[0];
  const viewedCount = useMemo(() => files.reduce((sum, file) => sum + Number(file.viewed), 0), [files]);

  const viewedMutation = useMutation({
    mutationFn: (input: { path: string; viewed: boolean }) => {
      if (!cl || currentContext.current !== contextKey) throw new Error("Navigation context is unavailable");
      return megaPost(["cls", String(cl.number), "viewed"], input);
    },
    onSuccess: (_, input) => {
      queryClient.setQueryData<CL>(megaQueryKeys.cl(routeId), (current) => current && ({
        ...current,
        files: current.files.map((file) => file.path === input.path ? { ...file, viewed: input.viewed } : file),
      }));
    },
    onSettled: () => setPendingReceipt(null),
  });

  function markViewed(path: string, viewed: boolean) {
    if (currentContext.current !== contextKey) return;
    if (localProgress) setLocalError(!setViewed(path, viewed));
    else if (!viewedMutation.isPending) {
      setPendingReceipt({ path, viewed });
      viewedMutation.mutate({ path, viewed });
    }
  }

  function selectFile(path: string) {
    setJumpTarget({ path });
    if (path !== fileParam) updateReviewQuery("file", path);
  }

  if (clQuery.isPending) return <section aria-busy="true" data-mega-cls="files"><WorkspaceLoading label={text.loading} variant="files" /></section>;
  if (clQuery.isError && !cl) {
    return <section data-mega-cls="files"><div className={styles.notice} role="alert">
      <p>{text.error}</p><button type="button" data-mega-cls="retry" onClick={() => void clQuery.refetch()}>{text.retry}</button>
    </div></section>;
  }
  if (!files.length) return <section data-mega-cls="files"><p data-mega-cls="files-empty">{text.empty}</p></section>;

  const rangeControl = <div className={styles.range}>
    <GitCompareArrows size={15} aria-hidden="true" />
    {availableRanges.length ? <select aria-label={text.revisionRange} value={selectedRange} onChange={(e) => updateReviewQuery("range", e.target.value)}>
      <option value="">{text.allChanges}</option>
      {availableRanges.map((value) => <option key={value} value={value}>{text.toolbar.rangeBadge.replace("{range}", value)}</option>)}
    </select> : <span>{text.allChanges}</span>}
  </div>;

  return (
    <section className={styles.layout} data-tree-open={treeOpen} data-mega-cls="files">
      {treeOpen && <ReviewFileTree files={filtered} activePath={activeFile?.path} filter={filter} onFilterChange={(value) => {
        setFilter(value);
        setJumpTarget(undefined);
      }} onSelectPath={selectFile} />}
      <div className={styles.diffPane} data-mega-cls="files-diff">
        <ReviewToolbar files={files} viewedCount={viewedCount} treeOpen={treeOpen} onToggleTree={() => setTreeOpen(!treeOpen)}
          diffStyle={diffStyle} onDiffStyleChange={setDiffStyle} rangeControl={rangeControl} progressHint={localProgress ? text.browserProgress : undefined} />
        {rangeParam && !range && <p role="status" className={styles.notice}>{text.invalidRange.replace("{range}", rangeParam)}</p>}
        {(localError || viewedMutation.isError) && <p role="alert" className={styles.notice}>{text.viewedFailed}</p>}
        {activeFile ? <ReviewDiffs files={filtered} activePath={activeFile.path} jumpTarget={jumpTarget?.path === activeFile.path ? jumpTarget : undefined}
          onSelectFile={selectFile} diffStyle={diffStyle} viewedPending={viewedMutation.isPending || (localProgress && !scope)}
          onViewedChange={markViewed} /> : <p className={styles.empty}>{text.list.noMatches}</p>}
      </div>
    </section>
  );
}
