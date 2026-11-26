// megaui:apps/next-app/.../docs/graph/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-13): lean graph page — GET /api/mega/graph +
// dynamic xyflow view; hrefs prefixed with workspaceBase.
"use client";

import { WorkspaceLoading } from "../../components/workspace-loading";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

import type { ContentLinkGraph } from "./components/graph-view";

const ContentLinkGraphView = dynamic(() => import("./components/graph-view"), { ssr: false });

export default function DocsGraphPage() {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const graphText = t.workspace.docs.graph;
  const workspaceBase = `/${locale}/workspace`;

  const graphQuery = useQuery({
    queryKey: megaQueryKeys.contentLinkGraph(),
    queryFn: () => megaGet<ContentLinkGraph>("graph"),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const onNavigate = useCallback(
    (href: string) => {
      const path = href.startsWith("/") ? href : `/${href}`;
      router.push(`${workspaceBase}${path}`);
    },
    [router, workspaceBase],
  );

  if (graphQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-docs="graph">
        <WorkspaceLoading label={graphText.loading} variant="page" />
      </main>
    );
  }

  if (graphQuery.isError) {
    return (
      <main data-mega-docs="graph" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{graphText.error}</p>
          <button data-mega-docs="retry" onClick={() => void graphQuery.refetch()} type="button">
            {graphText.retry}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main data-mega-docs="graph" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)` }}>
      <p style={{ margin: 0 }}>
        <Link href={`${workspaceBase}/docs`}>{t.workspace.docs.sidebar.title}</Link>
      </p>
      <h1 data-mega-docs="graph-title" style={{ fontSize: "1.35rem", fontWeight: 700, margin: `${MEGA_SPACING_TOKENS[8]} 0` }}>
        {graphText.title}
      </h1>
      <ContentLinkGraphView graph={graphQuery.data} labels={graphText} onNavigate={onNavigate} />
    </main>
  );
}
