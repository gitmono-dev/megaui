// megaui-only (WA-10): lean files changed page — list + patch preview (no pierre SSR).
"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { CL } from "@megaui/core";
import { clFilePatchForRange, parseRevRange } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

// megaui-only (FS-92): wait for navigation before mounting actionable content.
export default function CLFilesPage() {
  const params = useParams<{ n: string }>();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  if (params === null || searchParams === null) {
    return <section aria-busy="true" data-mega-cls="files"><p>{t.workspace.clDetail.files.loading}</p></section>;
  }
  return <ReadyCLFilesPage clNumber={Number(params.n)} searchParams={searchParams} />;
}

function ReadyCLFilesPage({ clNumber, searchParams }: {
  clNumber: number;
  searchParams: NonNullable<ReturnType<typeof useSearchParams>>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filesText = t.workspace.clDetail.files;
  const contextKey = `${clNumber}?${searchParams.toString()}`;
  const currentContext = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = null; };
  }, [contextKey]);
  const rangeParam = searchParams.get("range");
  const fileParam = searchParams.get("file");

  const clQuery = useQuery({
    queryKey: megaQueryKeys.cl(clNumber),
    queryFn: () => megaGet<CL>(["cls", String(clNumber)]),
    enabled: Number.isInteger(clNumber) && clNumber > 0,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const range = useMemo(
    () => (clQuery.data ? parseRevRange(rangeParam, clQuery.data.revisions) : undefined),
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
      return megaPost(["cls", String(clNumber), "viewed"], input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.cl(clNumber) });
    },
  });

  if (clQuery.isPending) {
    return (
      <section aria-busy="true" data-mega-cls="files">
        <p>{filesText.loading}</p>
      </section>
    );
  }

  if (clQuery.isError) {
    return (
      <section data-mega-cls="files">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{filesText.error}</p>
          <button data-mega-cls="retry" onClick={() => void clQuery.refetch()} type="button">
            {filesText.retry}
          </button>
        </div>
      </section>
    );
  }

  if (files.length === 0) {
    return (
      <section data-mega-cls="files">
        <p data-mega-cls="files-empty">{filesText.empty}</p>
      </section>
    );
  }

  return (
    <section data-mega-cls="files" style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8], gridTemplateColumns: "240px 1fr" }}>
      <aside data-mega-cls="files-list" style={{ borderRight: `1px solid ${MEGA_TOKENS.border}` }}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {files.map((file) => (
            <li key={file.path}>
              <button
                data-mega-cls="file-row"
                data-active={file.path === activeFile?.path ? "true" : "false"}
                onClick={() => setSelectedPath(file.path)}
                type="button"
                style={{
                  background: file.path === activeFile?.path ? MEGA_TOKENS.subtle : "transparent",
                  border: "none",
                  color: MEGA_TOKENS.text,
                  cursor: "pointer",
                  display: "block",
                  padding: MEGA_SPACING_TOKENS[6],
                  textAlign: "left",
                  width: "100%",
                }}
              >
                {file.path}
                <span style={{ color: MEGA_TOKENS.muted }}> +{file.additions}/−{file.deletions}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div data-mega-cls="files-diff">
        {rangeParam && !range ? (
          <p role="status">{filesText.invalidRange.replace("{range}", rangeParam)}</p>
        ) : null}
        <header style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8], marginBottom: MEGA_SPACING_TOKENS[8] }}>
          <strong>{activeFile?.path}</strong>
          {activeFile ? (
            <button
              data-mega-cls="file-viewed"
              disabled={viewedMutation.isPending}
              onClick={() =>
                viewedMutation.mutate({ path: activeFile.path, viewed: !activeFile.viewed })
              }
              type="button"
            >
              {activeFile.viewed ? t.workspace.clDetail.conversation.viewed : filesText.toolbar.viewed}
            </button>
          ) : null}
        </header>
        <pre
          data-mega-cls="diff-patch"
          style={{
            background: MEGA_TOKENS.subtle,
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            fontFamily: MEGA_TOKENS.fontMono,
            fontSize: "calc(var(--mega-density-font-size) - 1px)",
            margin: 0,
            overflow: "auto",
            padding: MEGA_SPACING_TOKENS[8],
            whiteSpace: "pre-wrap",
          }}
        >
          {patch || t.workspace.clDetail.conversation.emptyPatch}
        </pre>
      </div>
    </section>
  );
}
