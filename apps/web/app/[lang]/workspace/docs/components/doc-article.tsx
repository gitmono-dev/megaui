"use client";

import { type ReactNode, type RefObject } from "react";

import type { Doc } from "@megaui/core";
import { MegaContentReader } from "@megaui/ui/content/reader";
import { ShellAvatar } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_SURFACE_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { bodyHasVisibleContent } from "./doc-outline";
import { DocsIcon } from "./docs-icons";
import { RelativeTime } from "./relative-time";

export interface DocArticleLabels {
  blockRefs: {
    forbidden: string;
    unresolved: string;
  };
  commentsAriaLabel: string;
  createdAt: string;
  createRefPage: string;
  embeds: {
    cycle: string;
    loading: string;
    noAccess: string;
    openSource: string;
    tooDeep: string;
    unresolved: string;
  };
  emptyBody: string;
  openEditor: string;
  statusPublished: string;
  statusDraft: string;
  updatedAt: string;
  viewsAriaLabel: string;
}

export interface DocArticleProps {
  articleRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
  doc: Doc;
  labels: DocArticleLabels;
  locale: string;
  now: string;
  referenceBadges?: ReactNode;
  variant: "writer" | "reader";
  workspaceBase: string;
}

function interpolateTime(template: string, iso: string, locale: string, now: string) {
  const [before = "", after = ""] = template.split("{time}");
  return (
    <>
      {before}
      <RelativeTime locale={locale} now={now} value={iso} />
      {after}
    </>
  );
}

/** DC-02 / Roam center column: chips, title, byline, paper body. */
export function DocArticle({
  articleRef,
  children,
  doc,
  labels,
  locale,
  now,
  referenceBadges,
  variant,
  workspaceBase,
}: DocArticleProps) {
  const chips: { color: string; label: string }[] = [
    ...doc.tags.map((tag) => ({ color: tag.color ?? MEGA_TOKENS.accent, label: tag.name })),
    ...(doc.status
      ? [
          {
            color: doc.status === "published" ? MEGA_TOKENS.success : MEGA_TOKENS.warning,
            label: doc.status === "published" ? labels.statusPublished : labels.statusDraft,
          },
        ]
      : []),
  ];
  const empty = !bodyHasVisibleContent(doc.body);

  return (
    <article
      data-mega-docs="article"
      ref={articleRef}
      style={{
        position: "relative",
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4) calc(${MEGA_SPACING_TOKENS[8]} * 4) calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
      }}
    >
      {chips.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: MEGA_SPACING_TOKENS[6],
            marginBottom: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]})`,
          }}
        >
          {chips.map((chip) => (
            <span
              key={chip.label}
              style={{
                background: `color-mix(in srgb, ${chip.color} 13%, transparent)`,
                borderRadius: MEGA_RADIUS_TOKENS.md,
                color: chip.color,
                fontSize: "calc(var(--mega-density-font-size) - 3px)",
                fontWeight: 700,
                padding: `${MEGA_SPACING_TOKENS[1]} ${MEGA_SPACING_TOKENS[6]}`,
              }}
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}

      <h1
        data-mega-docs="detail-title"
        style={{
          color: MEGA_TOKENS.text,
          fontSize: MEGA_SURFACE_TOKENS.pageTitleSize,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          lineHeight: 1.2,
          margin: `0 0 calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
        }}
      >
        {doc.title}
      </h1>

      <div
        data-mega-docs="byline"
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          color: MEGA_TOKENS.muted,
          display: "flex",
          flexWrap: "wrap",
          fontSize: MEGA_SURFACE_TOKENS.fieldFontSize,
          gap: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
          marginBottom: `calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
          paddingBottom: `calc(${MEGA_SPACING_TOKENS[8]} * 2.5)`,
        }}
      >
        <ShellAvatar size={22} user={doc.author} />
        <span style={{ color: MEGA_TOKENS.text, fontWeight: 600 }}>{doc.author.displayName}</span>
        <span>· {interpolateTime(labels.createdAt, doc.createdAt, locale, now)}</span>
        <span>· {interpolateTime(labels.updatedAt, doc.updatedAt, locale, now)}</span>
        <span style={{ flex: 1 }} />
        <span
          aria-label={labels.viewsAriaLabel.replace("{count}", String(doc.viewCount))}
          role="img"
          style={{ alignItems: "center", display: "inline-flex", gap: MEGA_SPACING_TOKENS[4] }}
        >
          <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="eye" size={13} /> {doc.viewCount}
        </span>
        <span
          aria-label={labels.commentsAriaLabel.replace("{count}", String(doc.commentCount))}
          role="img"
          style={{ alignItems: "center", display: "inline-flex", gap: MEGA_SPACING_TOKENS[4] }}
        >
          <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="chat" size={13} /> {doc.commentCount}
        </span>
      </div>

      {articleBody({ children, doc, empty, labels, variant, workspaceBase })}
      {referenceBadges}
    </article>
  );
}

function articleBody({
  children,
  doc,
  empty,
  labels,
  variant,
  workspaceBase,
}: {
  children: ReactNode;
  doc: Doc;
  empty: boolean;
  labels: DocArticleLabels;
  variant: DocArticleProps["variant"];
  workspaceBase: string;
}) {
  switch (variant) {
    case "writer":
      return children;
    case "reader":
      return (
        <>
          {empty ? (
            <p
              data-mega-docs="empty-body"
              style={{
                background: MEGA_TOKENS.subtle,
                borderRadius: MEGA_SURFACE_TOKENS.controlRadius,
                color: MEGA_TOKENS.muted,
                fontSize: MEGA_SURFACE_TOKENS.fieldFontSize,
                margin: `0 0 calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
                padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]}) calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
              }}
            >
              {labels.emptyBody}
            </p>
          ) : null}
          <div data-mega-docs="reader">
            <MegaContentReader
              blockRefLabels={labels.blockRefs}
              createLabel={labels.createRefPage}
              embedLabels={labels.embeds}
              stateJSON={doc.body}
              workspaceBase={workspaceBase}
            />
          </div>
        </>
      );
    default: {
      const _exhaustive: never = variant;
      throw new Error(`unhandled DocArticle variant: ${_exhaustive}`);
    }
  }
}
