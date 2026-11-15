"use client";

import type { Doc } from "@megaui/core";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { DocCard, type DocCardLabels } from "./doc-card";

export interface DocsGridProps {
  docs: readonly Doc[];
  emptyLabel: string;
  labels: DocCardLabels;
  locale: string;
  now: string;
  onOpen(doc: Doc): void;
  onToggleStar(doc: Doc): void;
}

/**
 * Masonry via CSS columns (v6 / DC-01): 4 / 3 / 2 / 1 at 1280 / 1024 / 720.
 */
export function DocsGrid({ docs, emptyLabel, labels, locale, now, onOpen, onToggleStar }: DocsGridProps) {
  if (docs.length === 0) {
    return (
      <p data-mega-docs="empty" style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="mega-docs-masonry" data-mega-docs="grid">
      <style>{`
        .mega-docs-masonry { column-count: 4; column-gap: 14px; }
        .mega-docs-masonry [data-mega-docs="card"]:hover { border-color: ${MEGA_TOKENS.accent}; }
        .mega-docs-masonry .mega-doc-star { opacity: 0; transition: opacity 120ms ease; }
        .mega-docs-masonry [data-mega-docs="card"]:hover .mega-doc-star,
        .mega-docs-masonry .mega-doc-star:focus-visible,
        .mega-docs-masonry [data-mega-docs="card"][data-starred="true"] .mega-doc-star { opacity: 1; }
        @media (max-width: 1280px) { .mega-docs-masonry { column-count: 3; } }
        @media (max-width: 1024px) { .mega-docs-masonry { column-count: 2; } }
        @media (max-width: 720px) { .mega-docs-masonry { column-count: 1; } }
      `}</style>
      {docs.map((doc) => (
        <DocCard
          doc={doc}
          key={doc.id}
          labels={labels}
          locale={locale}
          now={now}
          onOpen={onOpen}
          onToggleStar={onToggleStar}
        />
      ))}
    </div>
  );
}
