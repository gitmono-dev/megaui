// megaui:apps/next-app/app/[lang]/workspace/code/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-08):
// - No workspace toggle-star (mega2-backed; star unavailable).
// - Fail-closed: root-entries/workspace errors surface alert+retry (no fixtures).
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { File as FileGlyph, Folder } from "lucide-react";
import { useMemo, type CSSProperties } from "react";

import type { CL, Issue, RootEntry, Workspace } from "@megaui/core";
import { isOpenCLState } from "@megaui/core";
import type { HomeDashboard } from "@/lib/adapter/home";
import { megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

const sectionStyle: CSSProperties = {
  background: MEGA_TOKENS.bg,
  borderBottom: `1px solid ${MEGA_TOKENS.border}`,
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 3.5) calc(${MEGA_SPACING_TOKENS[8]} * 1.75)`,
};

interface IssuePage {
  items: Issue[];
}

function sortEntries(entries: readonly RootEntry[]): RootEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export default function CodeRootPage() {
  const { locale, t } = useTranslation();
  const workspaceBase = `/${locale}/workspace`;
  const code = t.workspace.code;

  const workspaceQuery = useQuery({
    queryKey: megaQueryKeys.workspace(),
    queryFn: () => megaGet<Workspace>("workspace"),
  });
  const rootEntriesQuery = useQuery({
    queryKey: megaQueryKeys.rootEntries(),
    queryFn: () => megaGet<RootEntry[]>("root-entries"),
  });
  const clsQuery = useQuery({
    queryKey: megaQueryKeys.cls(),
    queryFn: () => megaGet<CL[]>("cls"),
  });
  const issuesQuery = useQuery({
    queryKey: megaQueryKeys.issues(),
    queryFn: () => megaGet<IssuePage>("issues", { filter: {} }),
  });
  const homeQuery = useQuery({
    queryKey: megaQueryKeys.home(),
    queryFn: () => megaGet<HomeDashboard>("home"),
  });

  const entries = useMemo(
    () => sortEntries(rootEntriesQuery.data ?? []),
    [rootEntriesQuery.data],
  );

  const openCls = (clsQuery.data ?? []).filter((cl) => isOpenCLState(cl.state)).length;
  const openIssues = (issuesQuery.data?.items ?? []).filter((issue) => issue.state === "open").length;
  const packagesCount = workspaceQuery.data?.packages.length ?? 0;
  const mainCI = homeQuery.data?.kpis.mainCI ?? "skipped";

  if (
    workspaceQuery.isPending ||
    rootEntriesQuery.isPending ||
    clsQuery.isPending ||
    issuesQuery.isPending ||
    homeQuery.isPending
  ) {
    return (
      <main aria-busy="true" data-mega-code="page">
        <div data-mega-code="skeleton" style={sectionStyle}>
          <div style={{ background: MEGA_TOKENS.subtle, borderRadius: MEGA_RADIUS_TOKENS.md, height: 44, maxWidth: 520 }} />
        </div>
        <span
          style={{
            clip: "rect(0 0 0 0)",
            clipPath: "inset(50%)",
            height: 1,
            overflow: "hidden",
            position: "absolute",
            whiteSpace: "nowrap",
            width: 1,
          }}
        >
          {code.loading}
        </span>
      </main>
    );
  }

  // Fail-closed on mega2-backed surfaces (workspace soft-fallback alone is not enough).
  if (rootEntriesQuery.isError || clsQuery.isError || issuesQuery.isError || homeQuery.isError) {
    return (
      <main data-mega-code="page">
        <div role="alert" style={{ ...sectionStyle, alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ color: MEGA_TOKENS.muted, fontSize: "var(--mega-density-font-size)", margin: 0 }}>{code.error}</p>
          <code style={{ color: MEGA_TOKENS.muted, fontFamily: MEGA_TOKENS.fontMono, fontSize: "calc(var(--mega-density-font-size) - 3px)" }}>
            MEGA-CODE-LOAD
          </code>
          <button
            data-mega-code="retry"
            onClick={() => {
              for (const query of [workspaceQuery, rootEntriesQuery, clsQuery, issuesQuery, homeQuery]) {
                if (query.isError) void query.refetch();
              }
            }}
            type="button"
          >
            {code.retry}
          </button>
        </div>
      </main>
    );
  }

  const workspace = workspaceQuery.data;

  return (
    <main data-mega-code="page">
      <header data-mega-code="header" style={sectionStyle}>
        <div style={{ alignItems: "baseline", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <h1 data-mega-code="workspace-name" style={{ fontSize: "1.35rem", fontWeight: 650, margin: 0 }}>
            {workspace?.name ?? "Mega"}
          </h1>
          <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
            {code.header.monorepoChip}
          </span>
          <span title={code.header.starUnavailable} style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
            ★
          </span>
        </div>
        <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[8]} 0 0` }}>
          {code.header.packagesCount.replace("{count}", String(packagesCount))} ·{" "}
          {code.header.activeCls.replace("{count}", String(openCls))}
        </p>
        <div data-mega-code="stats" style={{ display: "flex", flexWrap: "wrap", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`, marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
          <span>{code.stats.packages}: {packagesCount}</span>
          <span>{code.stats.openCls}: {openCls}</span>
          <span>{code.stats.openIssues}: {openIssues}</span>
          <span>{code.stats.mainCI}: {code.stats.ci[mainCI]}</span>
        </div>
      </header>

      <section
        data-mega-code="root-table"
        style={{
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 3.5) calc(${MEGA_SPACING_TOKENS[8]} * 5)`,
        }}
      >
        {entries.length === 0 ? (
          <p data-mega-code="empty" style={{ color: MEGA_TOKENS.muted }}>
            {code.table.empty}
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {entries.map((entry) => {
              const href = `${workspaceBase}/code/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
              const Icon = entry.kind === "directory" ? Folder : FileGlyph;
              return (
                <li key={entry.path} data-mega-code="root-row" style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: `${MEGA_SPACING_TOKENS[6]} 0` }}>
                  <Link href={href} style={{ alignItems: "center", color: MEGA_TOKENS.text, display: "inline-flex", gap: MEGA_SPACING_TOKENS[6], textDecoration: "none" }}>
                    <Icon aria-hidden size={14} />
                    <span>{entry.name}</span>
                    {entry.packageId ? (
                      <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 2px)" }}>{code.table.pkgBadge}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
