// megaui:apps/next-app/app/[lang]/workspace/cls/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-09): lean list without FilterQueryBar/MegaIcon ports;
// filter via `?q=` + `@megaui/core` parseQuery/serializeQuery.
"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useMemo, useState, type CSSProperties } from "react";

import type { CL } from "@megaui/core";
import { matchesCLFilter, parseQuery } from "@megaui/core";
import { megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";

const sectionPad: CSSProperties = {
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
};

function CLListContent() {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const workspaceBase = `/${locale}/workspace`;
  const clsText = t.workspace.clsList;
  const pageSize = typeof clsText.pageSize === "number" ? clsText.pageSize : 20;
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(searchParams?.get("new") === "1");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBranch, setDraftBranch] = useState("feat/");
  const [draftPackage, setDraftPackage] = useState("pkg_engine");

  const query = searchParams?.get("q") ?? "";
  const filter = useMemo(() => parseQuery(query), [query]);

  const setQuery = (nextQuery: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (nextQuery.trim()) params.set("q", nextQuery);
    else params.delete("q");
    params.delete("new");
    setPage(1);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const listQuery = useQuery({
    queryKey: megaQueryKeys.cls(query ? filter : undefined),
    queryFn: () => megaGet<CL[]>("cls", query ? { filter } : undefined),
  });

  const createMutation = useMutation({
    mutationFn: (input: { branch: string; packageId: string; title: string }) => megaPost<CL>("cls", input),
    onSuccess: (cl) => {
      const actorId = session?.user?.id ?? "";
      if (matchesCLFilter(cl, filter, actorId)) {
        queryClient.setQueryData<CL[]>(megaQueryKeys.cls(query ? filter : undefined), (current) =>
          current ? [cl, ...current] : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.cls() });
      setDialogOpen(false);
      router.push(`${workspaceBase}/cls/${cl.number}`);
    },
  });

  if (listQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-cls="page" style={sectionPad}>
        <p style={{ color: MEGA_TOKENS.muted }}>{clsText.loading}</p>
      </main>
    );
  }

  if (listQuery.isError) {
    return (
      <main data-mega-cls="page" style={sectionPad}>
        <div role="alert" style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{clsText.error}</p>
          <button data-mega-cls="retry" onClick={() => void listQuery.refetch()} type="button">
            {clsText.retry}
          </button>
        </div>
      </main>
    );
  }

  const rows = listQuery.data ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <main data-mega-cls="page" style={{ background: MEGA_TOKENS.bg, minHeight: "100%" }}>
      <div style={sectionPad}>
        <div style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <h1 data-mega-cls="title" style={{ fontSize: "1.35rem", fontWeight: 700, margin: 0 }}>
            {clsText.title}
          </h1>
          <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
            {clsText.replacesPr}
          </span>
          <span style={{ flex: 1 }} />
          <button data-mega-cls="new" onClick={() => setDialogOpen(true)} type="button">
            {clsText.newCl}
          </button>
        </div>

        <label style={{ display: "block", marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
          <span style={{ clip: "rect(0 0 0 0)", clipPath: "inset(50%)", height: 1, overflow: "hidden", position: "absolute", width: 1 }}>
            {clsText.filterAriaLabel}
          </span>
          <input
            data-mega-cls="filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={clsText.filterPlaceholder}
            style={{
              background: MEGA_TOKENS.subtle,
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              padding: MEGA_SPACING_TOKENS[8],
              width: "100%",
            }}
            value={query}
          />
        </label>

        {rows.length === 0 ? (
          <p data-mega-cls="empty" style={{ color: MEGA_TOKENS.muted, marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
            {clsText.empty}
          </p>
        ) : (
          <ul data-mega-cls="table" style={{ listStyle: "none", margin: `calc(${MEGA_SPACING_TOKENS[8]} * 2) 0 0`, padding: 0 }}>
            {pageRows.map((cl) => (
              <li
                data-mega-cls="row"
                key={cl.id}
                style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: `${MEGA_SPACING_TOKENS[8]} 0` }}
              >
                <Link href={`${workspaceBase}/cls/${cl.number}`} style={{ color: MEGA_TOKENS.text, textDecoration: "none" }}>
                  <strong>!{cl.number}</strong> {cl.title}
                </Link>
                <div style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)", marginTop: MEGA_SPACING_TOKENS[4] }}>
                  {clsText.row.states[cl.state]} · {cl.packageId} · +{cl.additions}/−{cl.deletions}
                </div>
              </li>
            ))}
          </ul>
        )}
        {rows.length > pageSize ? (
          <div data-mega-cls="pagination" style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8], marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
            <button data-mega-cls="page-prev" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} type="button">
              {clsText.pagination.previous}
            </button>
            <span data-mega-cls="page-status">
              {clsText.pagination.pageStatus.replace("{page}", String(safePage)).replace("{total}", String(totalPages))}
            </span>
            <button data-mega-cls="page-next" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} type="button">
              {clsText.pagination.next}
            </button>
          </div>
        ) : null}
      </div>

      {dialogOpen ? (
        <div
          data-mega-cls="new-dialog"
          role="dialog"
          style={{
            background: "rgba(0,0,0,0.35)",
            inset: 0,
            position: "fixed",
            zIndex: 40,
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate({
                branch: draftBranch,
                packageId: draftPackage,
                title: draftTitle,
              });
            }}
            style={{
              background: MEGA_TOKENS.bg,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              left: "50%",
              maxWidth: 420,
              padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
              position: "absolute",
              top: "20%",
              transform: "translateX(-50%)",
              width: "90%",
            }}
          >
            <h2 style={{ marginTop: 0 }}>{clsText.newDialog.title}</h2>
            <label style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[8] }}>
              {clsText.newDialog.titleLabel}
              <input data-mega-cls="new-title" onChange={(e) => setDraftTitle(e.target.value)} required value={draftTitle} style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[8] }}>
              {clsText.newDialog.packageLabel}
              <input data-mega-cls="new-package" onChange={(e) => setDraftPackage(e.target.value)} required value={draftPackage} style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ display: "block", marginBottom: MEGA_SPACING_TOKENS[8] }}>
              {clsText.newDialog.branchLabel}
              <input data-mega-cls="new-branch" onChange={(e) => setDraftBranch(e.target.value)} required value={draftBranch} style={{ display: "block", width: "100%" }} />
            </label>
            <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], justifyContent: "flex-end" }}>
              <button onClick={() => setDialogOpen(false)} type="button">
                {clsText.newDialog.cancel}
              </button>
              <button data-mega-cls="new-submit" disabled={createMutation.isPending} type="submit">
                {createMutation.isPending ? clsText.newDialog.submitting : clsText.newDialog.submit}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

export default function CLListPage() {
  return (
    <Suspense fallback={<main data-mega-cls="page" />}>
      <CLListContent />
    </Suspense>
  );
}
