// megaui:apps/next-app/app/[lang]/workspace/issues/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-11): issue list filtering and creation through the BFF.
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, type CSSProperties, useMemo, useState } from "react";

import type { Issue } from "@megaui/core";
import { parseQuery, serializeQuery } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

import { IssueCreateDialog, type IssuePriority } from "./components/issue-create-dialog";
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
  const queryClient = useQueryClient();
  const issuesText = t.workspace.issues;
  const workspaceBase = `/${locale}/workspace`;
  const [dialogOpen, setDialogOpen] = useState(searchParams?.get("new") === "1");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftPackage, setDraftPackage] = useState("pkg_engine");
  const [draftPriority, setDraftPriority] = useState<IssuePriority>("P2");
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
  const listQuery = useQuery({
    queryKey: [...megaQueryKeys.issues(filter), page, PAGE_SIZE],
    queryFn: () =>
      megaGet<IssueListPage>("issues", {
        filter,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });
  const createMutation = useMutation({
    mutationFn: (input: {
      readonly body?: string;
      readonly packageId: string;
      readonly priority: IssuePriority;
      readonly title: string;
    }) => megaPost<Issue>("issues", input),
    onSuccess: (issue) => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issues() });
      setDialogOpen(false);
      router.push(`${workspaceBase}/issues/${issue.number}`);
    },
  });

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
          onNewIssue={() => setDialogOpen(true)}
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
      {dialogOpen ? (
        <IssueCreateDialog
          body={draftBody}
          copy={issuesText.newDialog}
          isPending={createMutation.isPending}
          onBodyChange={setDraftBody}
          onCancel={() => setDialogOpen(false)}
          onPackageChange={setDraftPackage}
          onPriorityChange={setDraftPriority}
          onSubmit={(input) => createMutation.mutate(input)}
          onTitleChange={setDraftTitle}
          packageId={draftPackage}
          priority={draftPriority}
          title={draftTitle}
        />
      ) : null}
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
