"use client";

import Link from "next/link";

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export interface DocLinkedRefItem {
  contextSummary: string | null;
  href: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
}

export interface DocUnlinkedRefItem {
  kind: "doc" | "issue" | "cl";
  targetId: string;
  targetTitle: string;
}

export interface DocReferencesLabels {
  empty: string;
  title: string;
  typeCl: string;
  typeDoc: string;
  typeIssue: string;
  typeOther: string;
  unlinkedEmpty: string;
  unlinkedTitle: string;
}

export interface DocReferencesProps {
  labels: DocReferencesLabels;
  linked?: readonly DocLinkedRefItem[];
  linkedPending: boolean;
  loadingLabel: string;
  unlinked?: readonly DocUnlinkedRefItem[];
  unlinkedPending: boolean;
  workspaceBase: string;
}

function resolveWorkspaceHref(workspaceBase: string, href: string): string {
  const path = href.startsWith("/") ? href : `/${href}`;
  return `${workspaceBase}${path}`;
}

function groupLinkedReferences(items: readonly DocLinkedRefItem[]) {
  const sources = new Map<string, DocLinkedRefItem & { count: number }>();
  for (const item of items) {
    const key = `${item.sourceType}:${item.sourceId}`;
    const source = sources.get(key);
    if (source) source.count += 1;
    else sources.set(key, { ...item, count: 1 });
  }
  return [...sources.values()];
}

function unlinkedHref(workspaceBase: string, item: DocUnlinkedRefItem): string {
  switch (item.kind) {
    case "doc":
      return `${workspaceBase}/docs/${encodeURIComponent(item.targetId)}`;
    case "issue":
      return `${workspaceBase}/issues/${encodeURIComponent(item.targetId)}`;
    case "cl":
      return `${workspaceBase}/cls/${encodeURIComponent(item.targetId)}`;
    default: {
      const _exhaustive: never = item.kind;
      throw new Error(`unhandled unlinked kind: ${_exhaustive}`);
    }
  }
}

function unlinkedTypeLabel(kind: DocUnlinkedRefItem["kind"], labels: DocReferencesLabels): string {
  switch (kind) {
    case "doc":
      return labels.typeDoc;
    case "issue":
      return labels.typeIssue;
    case "cl":
      return labels.typeCl;
    default: {
      const _exhaustive: never = kind;
      return labels.typeOther;
    }
  }
}

const sectionStyle = {
  margin: `0 auto ${MEGA_SPACING_TOKENS[8]}`,
  maxWidth: 760,
  padding: `0 calc(${MEGA_SPACING_TOKENS[8]} * 4)`,
} as const;

const headingStyle = {
  color: MEGA_TOKENS.text,
  fontSize: "calc(var(--mega-density-font-size) + 1px)",
  fontWeight: 700,
  margin: `0 0 ${MEGA_SPACING_TOKENS[8]}`,
} as const;

const listStyle = {
  display: "grid",
  gap: MEGA_SPACING_TOKENS[5],
  listStyle: "none",
  margin: 0,
  padding: 0,
} as const;

/** Linked / Unlinked references below the outliner and above comments. */
export function DocReferences({
  labels,
  linked,
  linkedPending,
  loadingLabel,
  unlinked,
  unlinkedPending,
  workspaceBase,
}: DocReferencesProps) {
  const linkedItems = groupLinkedReferences(Array.isArray(linked) ? linked : []);
  const unlinkedItems = Array.isArray(unlinked) ? unlinked : [];

  return (
    <>
      <section data-mega-docs="linked-refs" style={sectionStyle}>
        <h2 style={headingStyle}>{labels.title}</h2>
        {linkedPending ? <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{loadingLabel}</p> : null}
        {!linkedPending && linkedItems.length === 0 ? (
          <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{labels.empty}</p>
        ) : null}
        {linkedItems.length > 0 ? (
          <ul style={listStyle}>
            {linkedItems.map((item) => (
              <li data-mega-docs="linked-ref" key={`${item.sourceType}:${item.sourceId}`}>
                <Link
                  href={resolveWorkspaceHref(workspaceBase, item.href)}
                  style={{ color: MEGA_TOKENS.accent, textDecoration: "none" }}
                >
                  {item.sourceTitle}
                  {item.count > 1 ? (
                    <sup
                      style={{ fontSize: "0.75em", lineHeight: 0, marginLeft: MEGA_SPACING_TOKENS[3], verticalAlign: "super" }}
                    >
                      {item.count}
                    </sup>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section data-mega-docs="unlinked-refs" style={sectionStyle}>
        <h2 style={headingStyle}>{labels.unlinkedTitle}</h2>
        {unlinkedPending ? <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{loadingLabel}</p> : null}
        {!unlinkedPending && unlinkedItems.length === 0 ? (
          <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{labels.unlinkedEmpty}</p>
        ) : null}
        {unlinkedItems.length > 0 ? (
          <ul style={listStyle}>
            {unlinkedItems.map((item) => (
              <li data-mega-docs="unlinked-ref" key={`${item.kind}:${item.targetId}`}>
                <Link href={unlinkedHref(workspaceBase, item)} style={{ color: MEGA_TOKENS.accent, textDecoration: "none" }}>
                  {item.targetTitle}
                </Link>
                <span style={{ color: MEGA_TOKENS.muted, marginLeft: MEGA_SPACING_TOKENS[6] }}>
                  {unlinkedTypeLabel(item.kind, labels)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
