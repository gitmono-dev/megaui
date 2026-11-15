"use client";

import { SideNavItem } from "@megaui/ui/shell";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { DocsIcon } from "./docs-icons";
import type { TocEntry } from "./doc-outline";

export interface DocTocLabels {
  readingTime: string;
  title: string;
  versions: string;
}

export interface DocTocProps {
  activeIndex: number | null;
  entries: readonly TocEntry[];
  labels: DocTocLabels;
  minutes: number;
  onSelect(entry: TocEntry): void;
  versionCount: number;
}

/** DC-02 left rail: heading TOC + reading meta, library sidebar tokens. */
export function DocToc({ activeIndex, entries, labels, minutes, onSelect, versionCount }: DocTocProps) {
  return (
    <nav
      aria-label={labels.title}
      data-mega-docs="toc"
      style={{
        background: MEGA_TOKENS.subtle,
        borderRight: `1px solid ${MEGA_TOKENS.border}`,
        flexShrink: 0,
        minHeight: 0,
        overflow: "auto",
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) 0`,
        width: 220,
      }}
    >
      <div
        style={{
          color: MEGA_TOKENS.muted,
          fontSize: "calc(var(--mega-density-font-size) - 2px)",
          fontWeight: 700,
          letterSpacing: 0.5,
          padding: `0 calc(${MEGA_SPACING_TOKENS[8]} * 2) ${MEGA_SPACING_TOKENS[8]}`,
          textTransform: "uppercase",
        }}
      >
        {labels.title}
      </div>
      <div style={{ padding: `0 ${MEGA_SPACING_TOKENS[6]}` }}>
        {entries.map((entry) => (
          <SideNavItem
            active={entry.index === activeIndex}
            data-heading-index={entry.index}
            data-mega-docs="toc-entry"
            key={entry.index}
            label={<span style={{ paddingLeft: (entry.level - 1) * 14 }}>{entry.text}</span>}
            onSelect={() => onSelect(entry)}
            semantics="navigation"
            variant="toc"
          />
        ))}
      </div>
      <div
        style={{
          borderTop: `1px solid ${MEGA_TOKENS.border}`,
          color: MEGA_TOKENS.muted,
          fontSize: "calc(var(--mega-density-font-size) - 2px)",
          lineHeight: 1.6,
          margin: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]}) calc(${MEGA_SPACING_TOKENS[8]} * 2) 0`,
          paddingTop: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]})`,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[6] }}>
          <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="clock" size={11} />
          {labels.readingTime.replace("{minutes}", String(minutes))}
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: MEGA_SPACING_TOKENS[6],
            marginTop: MEGA_SPACING_TOKENS[4],
          }}
        >
          <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="history" size={11} />
          {labels.versions.replace("{count}", String(versionCount))}
        </div>
      </div>
    </nav>
  );
}
