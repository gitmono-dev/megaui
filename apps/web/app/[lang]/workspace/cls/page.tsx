// megaui:apps/next-app/app/[lang]/workspace/cls/page.tsx@0ff3a9d
"use client";

import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownWideNarrow, ChevronDown, GitMerge, GitPullRequest, GitPullRequestClosed, List, Search } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import { isOpenCLState, MEGA_OPEN_CL_STATES, parseQuery, serializeQuery, type CL, type Filter } from "@megaui/core";
import { megaGet, megaQueryKeys } from "@megaui/ui/query";
import { WorkspaceLoading } from "@/app/[lang]/workspace/components/workspace-loading";
import { useTranslation } from "@/hooks/use-translation";
import { CLListRow } from "./components/cl-list-row";
import styles from "./cl-list.module.css";

const scopes = [
  { key: "all", icon: List },
  { key: "open", icon: GitPullRequest },
  { key: "merged", icon: GitMerge },
  { key: "closed", icon: GitPullRequestClosed },
] as const;
const sorts = ["updated-desc", "updated-asc", "created-desc", "created-asc"] as const;

function expandOpenFilter(filter: Filter): Filter {
  if (!filter.states?.includes("open")) return filter;
  const states = filter.states.flatMap(state => state === "open" ? [...MEGA_OPEN_CL_STATES] : [state]);
  return { ...filter, states: [...new Set(states)] };
}

function selectedScope(states: Filter["states"]) {
  if (!states?.length) return "all";
  if (states.length === MEGA_OPEN_CL_STATES.length && MEGA_OPEN_CL_STATES.every(state => states.includes(state))) return "open";
  return states.length === 1 ? states[0] : undefined;
}

function CLListContent() {
  const { locale, t } = useTranslation();
  const text = t.workspace.clsList;
  const query = useSearchParams()?.get("q") ?? "";
  const filter = useMemo(() => expandOpenFilter(parseQuery(query)), [query]);
  const activeScope = selectedScope(filter.states);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);

  // Preserve native input and IME selection while synchronizing toolbar edits and history navigation.
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== query &&
        (new URLSearchParams(window.location.search).get("q") ?? "") === query) {
      inputRef.current.value = query;
    }
  }, [query]);

  function setQuery(value: string) {
    const url = new URL(window.location.href);
    if (value.trim()) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    setPage(1);
    window.history.replaceState(null, "", url);
  }

  const listQuery = useQuery({
    queryKey: megaQueryKeys.cls(query ? filter : undefined),
    queryFn: () => megaGet<CL[]>("cls", query ? { filter } : undefined),
    refetchInterval: ({ state }) => {
      const open = state.data?.filter(cl => isOpenCLState(cl.state));
      if (!open?.length) return false;
      return open.some(cl => cl.ci === "queued" || cl.ci === "running") ? 3000 : 10000;
    },
  });

  const rows = listQuery.data ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / text.pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * text.pageSize, safePage * text.pageSize);
  const sort = sorts.find(value => value === filter.sort) ?? "updated-desc";

  return (
    <main data-mega-cls="page">
      <div>
        <h1 className={styles.heading} data-mega-cls="title">{text.title}</h1>

        <label className={styles.search}>
          <Search aria-hidden="true" />
          <input
            aria-label={text.filterAriaLabel}
            data-mega-cls="filter"
            defaultValue={query}
            onChange={(event) => {
              if (!(event.nativeEvent as InputEvent).isComposing) setQuery(event.currentTarget.value);
            }}
            onCompositionEnd={(event) => setQuery(event.currentTarget.value)}
            placeholder={text.filterPlaceholder}
            ref={inputRef}
            type="search"
          />
        </label>

        <section className={styles.panel} aria-label={text.title}>
          <div className={styles.toolbar}>
            <div className={styles.scopes} role="group" aria-label={text.dropdowns.state}>
              {scopes.map(({ key, icon: Icon }) => (
                <button
                  aria-pressed={activeScope === key}
                  className={styles.scope}
                  data-mega-control=""
                  data-scope={key}
                  key={key}
                  onClick={() => setQuery(serializeQuery({ ...parseQuery(query), states: key === "all" ? undefined : [key] }))}
                  type="button"
                >
                  <Icon size={15} aria-hidden="true" />
                  {text.scopes[key]}
                  {activeScope === key && listQuery.data && <span>{rows.length}</span>}
                </button>
              ))}
            </div>
            <label className={styles.sort}>
              <ArrowDownWideNarrow aria-hidden="true" />
              <select
                aria-label={text.dropdowns.sort}
                data-mega-cls="sort"
                onChange={(event) => {
                  const next = sorts.find(value => value === event.target.value);
                  if (next) setQuery(serializeQuery({ ...parseQuery(query), sort: next }));
                }}
                value={sort}
              >
                {sorts.map(value => <option key={value} value={value}>{text.dropdowns.sorts[value]}</option>)}
              </select>
              <ChevronDown aria-hidden="true" />
            </label>
          </div>
          {listQuery.isError && (
            <div className={styles.notice} data-mega-cls={listQuery.data ? "refresh-error" : "error"} role="alert">
              <p>{text.error}</p>
              <button data-mega-cls="retry" onClick={() => void listQuery.refetch()} type="button">{text.retry}</button>
            </div>
          )}
          {listQuery.isPending && <WorkspaceLoading label={text.loading} />}
          {listQuery.isSuccess && !rows.length && <p className={styles.notice} data-mega-cls="empty">{text.empty}</p>}
          {rows.length > 0 && (
            <ul className={styles.list} data-mega-cls="table">
              {pageRows.map(cl => <CLListRow key={cl.id} cl={cl} dateFormat={dateFormat} />)}
            </ul>
          )}
        </section>
        {totalPages > 1 && (
          <div className={styles.pagination} data-mega-cls="pagination">
            <button data-mega-cls="page-prev" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">
              {text.pagination.previous}
            </button>
            <span data-mega-cls="page-status">
              {text.pagination.pageStatus.replace("{page}", String(safePage)).replace("{total}", String(totalPages))}
            </span>
            <button data-mega-cls="page-next" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} type="button">
              {text.pagination.next}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function CLListPage() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<main aria-busy="true"><WorkspaceLoading label={t.workspace.clsList.loading} variant="page" /></main>}>
      <CLListContent />
    </Suspense>
  );
}
