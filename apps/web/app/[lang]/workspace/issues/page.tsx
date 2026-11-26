// megaui:apps/next-app/app/[lang]/workspace/issues/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-11): issue list filtering and creation through the BFF.
"use client";

import { redirect, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Suspense, type CSSProperties, useMemo, useState } from "react";

import type { Issue } from "@megaui/core";
import { parseQuery, serializeQuery } from "@megaui/core";
import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

import { IssueListControls } from "./components/issue-list-controls";
import { IssueListResults } from "./components/issue-list-results";

interface IssueListPage {
  readonly items: readonly Issue[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

const PAGE_SIZE = 20;
const sectionPad: CSSProperties = {
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
};

function IssuesListContent() {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const issuesText = t.workspace.issues;
  const workspaceBase = `/${locale}/workspace`;
  const [page, setPage] = useState(1);
  const query = searchParams?.get("q") ?? "is:open";
  const filter = useMemo(() => parseQuery(query), [query]);
  const stateTab =
    filter.states?.includes("closed") && !filter.states.includes("open") ? "closed" : "open";
  const setQuery = (nextQuery: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (nextQuery.trim()) params.set("q", nextQuery);
    else params.delete("q");
    params.delete("new");
    setPage(1);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const setStateTab = (next: "open" | "closed") => {
    setQuery(serializeQuery({ ...filter, states: [next] }));
  };
  const newHref = `${workspaceBase}/issues/new${searchParams?.get("q") ? `?q=${encodeURIComponent(query)}` : ""}`;
  const legacyNew = searchParams?.get("new") === "1";
  const listQuery = useQuery({
    enabled: !legacyNew,
    queryKey: [...megaQueryKeys.issues(filter), page, PAGE_SIZE],
    queryFn: () =>
      megaGet<IssueListPage>("issues", {
        filter,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });
  if (legacyNew) redirect(newHref);
  if (listQuery.isPending) return <IssueListLoading label={issuesText.loading} />;
  if (listQuery.isError) {
    return (
      <IssueListError
        label={issuesText.error}
        onRetry={() => void listQuery.refetch()}
        retryLabel={issuesText.retry}
      />
    );
  }

  const pageData = listQuery.data;
  const totalPages = Math.max(1, Math.ceil(pageData.total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  return (
    <main data-mega-issues="page" style={{ background: MEGA_TOKENS.bg, minHeight: "100%" }}>
      <div style={sectionPad}>
        <IssueListControls
          onNewIssue={() => router.push(newHref)}
          onQueryChange={setQuery}
          onSortChange={(sort) => setQuery(serializeQuery({ ...filter, sort }))}
          onStateChange={setStateTab}
          query={query}
          sort={filter.sort}
          state={stateTab}
          total={pageData.total}
        />
        <IssueListResults
          onNextPage={() => setPage((current) => Math.min(totalPages, current + 1))}
          onPreviousPage={() => setPage((current) => Math.max(1, current - 1))}
          page={safePage}
          pageSize={PAGE_SIZE}
          rows={pageData.items}
          total={pageData.total}
          totalPages={totalPages}
          workspaceBase={workspaceBase}
        />
      </div>
    </main>
  );
}

function IssueListLoading({ label }: { readonly label: string }) {
  return (
    <main aria-busy="true" data-mega-issues="page" style={sectionPad}>
      <p style={{ color: MEGA_TOKENS.muted }}>{label}</p>
    </main>
  );
}

function IssueListError({
  label,
  onRetry,
  retryLabel,
}: {
  readonly label: string;
  readonly onRetry: () => void;
  readonly retryLabel: string;
}) {
  return (
    <main data-mega-issues="page" style={sectionPad}>
      <div
        role="alert"
        style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}
      >
        <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{label}</p>
        <button data-mega-issues="retry" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      </div>
    </main>
  );
}

export default function IssuesPage() {
  return (
    <Suspense fallback={<main aria-busy="true" data-mega-issues="page" style={sectionPad} />}>
      <IssuesListContent />
    </Suspense>
  );
}
