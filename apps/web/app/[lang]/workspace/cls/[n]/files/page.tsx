"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { clFilePatchForRange, isCLReference, parseRevRange, type CL } from "@megaui/core";
import { MegaPatchView } from "@megaui/ui/code-view";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";

import { useTranslation } from "@/hooks/use-translation";
import styles from "./files.module.css";

// megaui-only (FS-92): wait for navigation before mounting actionable content.
export default function CLFilesPage() {
  const params = useParams<{ n: string }>();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  if (params === null || searchParams === null) {
    return <section aria-busy="true" data-mega-cls="files"><p>{t.workspace.clDetail.files.loading}</p></section>;
  }
  return <ReadyCLFilesPage key={params.n} routeId={params.n} searchParams={searchParams} />;
}

function ReadyCLFilesPage({ routeId, searchParams }: {
  routeId: string;
  searchParams: NonNullable<ReturnType<typeof useSearchParams>>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filesText = t.workspace.clDetail.files;
  const contextKey = `${routeId}?${searchParams.toString()}`;
  const currentContext = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = null; };
  }, [contextKey]);
  const rangeParam = searchParams.get("range");
  const fileParam = searchParams.get("file");

  const clQuery = useQuery({
    queryKey: megaQueryKeys.cl(routeId),
    queryFn: () => megaGet<CL>(["cls", routeId]),
    enabled: isCLReference(routeId),
    staleTime: 10_000,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });
  const range = useMemo(
    () => clQuery.data && parseRevRange(rangeParam, clQuery.data.revisions),
    [clQuery.data, rangeParam],
  );
  const files = clQuery.data?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const activePath = selectedPath ?? fileParam ?? files[0]?.path ?? null;
  const activeFile = files.find((file) => file.path === activePath) ?? files[0];
  const patch = activeFile ? clFilePatchForRange(activeFile, range) : "";

  const viewedMutation = useMutation({
    mutationFn: (input: { path: string; viewed: boolean }) => {
      if (currentContext.current !== contextKey) throw new Error("Navigation context is unavailable");
      if (!clQuery.data) throw new Error("CL detail is unavailable");
      return megaPost(["cls", String(clQuery.data.number), "viewed"], input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.cl(routeId) });
    },
  });

  if (clQuery.isPending) {
    return <section aria-busy="true" data-mega-cls="files"><p>{filesText.loading}</p></section>;
  }

  if (clQuery.isError && !clQuery.data) {
    return (
      <section data-mega-cls="files">
        <div className={styles.notice} role="alert">
          <p style={{ margin: 0 }}>{filesText.error}</p>
          <button data-mega-cls="retry" onClick={() => void clQuery.refetch()} type="button">
            {filesText.retry}
          </button>
        </div>
      </section>
    );
  }

  if (!activeFile) {
    return (
      <section data-mega-cls="files">
        <p data-mega-cls="files-empty">{filesText.empty}</p>
      </section>
    );
  }

  return (
    <section className={styles.layout} data-mega-cls="files">
      <aside aria-label={filesText.list.treeAriaLabel} className={styles.fileList} data-mega-cls="files-list">
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              <button
                aria-pressed={file.path === activeFile.path}
                className={styles.fileButton}
                data-mega-cls="file-row"
                data-active={file.path === activeFile.path ? "true" : "false"}
                onClick={() => setSelectedPath(file.path)}
                type="button"
              >
                <span className={styles.filePath}>{file.path}</span>
                <span className={styles.stat}>
                  <span className={styles.added}>+{file.additions}</span>{" "}
                  <span className={styles.deleted}>−{file.deletions}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className={styles.diffPane} data-mega-cls="files-diff">
        {rangeParam && !range ? (
          <p role="status">{filesText.invalidRange.replace("{range}", rangeParam)}</p>
        ) : null}
        <div className={styles.panel}>
          <header className={styles.header}>
            <strong className={styles.filePath}>{activeFile.path}</strong>
            <button
              aria-pressed={Boolean(activeFile.viewed)}
              data-mega-cls="file-viewed"
              disabled={viewedMutation.isPending}
              onClick={() =>
                viewedMutation.mutate({ path: activeFile.path, viewed: !activeFile.viewed })
              }
              type="button"
            >
              {activeFile.viewed ? t.workspace.clDetail.conversation.viewed : filesText.toolbar.viewed}
            </button>
          </header>
          <div className={styles.patch} data-mega-cls="diff-patch">
            <MegaPatchView
              binaryLabel={filesText.binary}
              emptyLabel={t.workspace.clDetail.conversation.emptyPatch}
              patch={patch}
              path={activeFile.path}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
