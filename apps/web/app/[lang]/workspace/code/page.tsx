// megaui:apps/next-app/app/[lang]/workspace/code/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-08):
// - No workspace toggle-star (mega2-backed; star unavailable).
// - Fail-closed: root-entries/workspace errors surface alert+retry (no fixtures).
// - megaui-only: admin-managed README (settings → Code README) below the root list;
//   it is optional decoration, so a load failure hides it instead of the page.
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { File as FileGlyph, Folder } from "lucide-react";
import { useMemo, type CSSProperties } from "react";

import type { ProseBlock, RootEntry } from "@megaui/core";
import { megaGet, megaQueryKeys } from "@megaui/ui/query";

import { getSiteName } from "@/lib/site-name";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { ReadmeProse } from "./components/readme-prose";

const sectionStyle: CSSProperties = {
  background: MEGA_TOKENS.bg,
  borderBottom: `1px solid ${MEGA_TOKENS.border}`,
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 3.5) calc(${MEGA_SPACING_TOKENS[8]} * 1.75)`,
};

interface CodeReadmeView {
  markdown: string;
  blocks: ProseBlock[];
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

  const rootEntriesQuery = useQuery({
    queryKey: megaQueryKeys.rootEntries(),
    queryFn: () => megaGet<RootEntry[]>("root-entries"),
  });

  const codeReadmeQuery = useQuery({
    queryKey: megaQueryKeys.codeReadme(),
    queryFn: () => megaGet<CodeReadmeView>("code-readme"),
  });
  const readmeBlocks = codeReadmeQuery.data?.blocks ?? [];

  const entries = useMemo(
    () => sortEntries(rootEntriesQuery.data ?? []),
    [rootEntriesQuery.data],
  );

  if (rootEntriesQuery.isPending) {
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
  if (rootEntriesQuery.isError) {
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
              for (const query of [rootEntriesQuery]) {
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

  return (
    <main data-mega-code="page">
      <header data-mega-code="header" style={sectionStyle}>
        <div style={{ alignItems: "baseline", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <h1 data-mega-code="workspace-name" style={{ fontSize: "1.35rem", fontWeight: 650, margin: 0 }}>
            {getSiteName()}
          </h1>
          <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
            {code.header.monorepoChip}
          </span>
          <span title={code.header.starUnavailable} style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
            ★
          </span>
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
              const isDirectory = entry.kind === "directory";
              const Icon = isDirectory ? Folder : FileGlyph;
              return (
                <li key={entry.path} data-kind={entry.kind} data-mega-code="root-row" style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: `${MEGA_SPACING_TOKENS[6]} 0` }}>
                  <Link href={href} style={{ alignItems: "center", color: MEGA_TOKENS.text, display: "inline-flex", fontSize: "var(--mega-density-font-size)", fontWeight: isDirectory ? 600 : 400, gap: MEGA_SPACING_TOKENS[6], textDecoration: "none" }}>
                    <Icon aria-hidden color={isDirectory ? MEGA_TOKENS.accent : MEGA_TOKENS.muted} size={16} />
                    <span>{entry.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {readmeBlocks.length > 0 ? (
        <section
          aria-label={code.readme.title}
          data-mega-code="root-readme"
          style={{
            padding: `0 calc(${MEGA_SPACING_TOKENS[8]} * 3.5) calc(${MEGA_SPACING_TOKENS[8]} * 5)`,
          }}
        >
          <div style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md }}>
            <h2
              style={{
                borderBottom: `1px solid ${MEGA_TOKENS.border}`,
                fontSize: "var(--mega-density-font-size)",
                fontWeight: 600,
                margin: 0,
                padding: MEGA_SPACING_TOKENS[8],
              }}
            >
              {code.readme.title}
            </h2>
            <ReadmeProse blocks={readmeBlocks} />
          </div>
        </section>
      ) : null}
    </main>
  );
}
