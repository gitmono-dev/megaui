"use client";

import type { RefObject } from "react";

import { KbdChip } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { DocsIcon, type DocsIconName } from "./docs-icons";
import type { DocsSort } from "./docs-filter";

export interface DocsHeaderLabels {
  deferredTooltip: string;
  newDoc: string;
  searchAriaLabel: string;
  searchPlaceholder: string;
  sortTitle: string;
  sortUpdated: string;
  stats: string;
  viewAriaLabel: string;
  viewGrid: string;
  viewList: string;
  viewWall: string;
}

export interface DocsHeaderProps {
  authorCount: number;
  docCount: number;
  folderCount: number;
  labels: DocsHeaderLabels;
  onNewDoc(): void;
  onSearchChange(text: string): void;
  onSortToggle(): void;
  search: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  sort: DocsSort;
  title: string;
}

/** v6 / DC-01 header: stacked title+stats, ⌘F search, Grid-only view, sort, New doc. */
export function DocsHeader({
  authorCount,
  docCount,
  folderCount,
  labels,
  onNewDoc,
  onSearchChange,
  onSortToggle,
  search,
  searchInputRef,
  sort,
  title,
}: DocsHeaderProps) {
  const views: { active?: boolean; icon: DocsIconName; label: string }[] = [
    { icon: "layers", active: true, label: labels.viewGrid },
    { icon: "stack", label: labels.viewWall },
    { icon: "file", label: labels.viewList },
  ];

  return (
    <header
      data-mega-docs="header"
      style={{
        alignItems: "center",
        background: MEGA_TOKENS.bg,
        borderBottom: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        flexWrap: "wrap",
        gap: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]}) calc(${MEGA_SPACING_TOKENS[8]} * 3) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          alignItems: "center",
          background: MEGA_TOKENS.activeBg,
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
          display: "flex",
          height: 28,
          justifyContent: "center",
          width: 28,
        }}
      >
        <DocsIcon color={MEGA_TOKENS.accent} name="plus" size={14} />
      </span>
      <div>
        <h1
          data-mega-docs="title"
          style={{
            color: MEGA_TOKENS.text,
            fontSize: "calc(var(--mega-density-font-size) + 3px)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          {title}
        </h1>
        <p
          data-mega-docs="stats"
          style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 2px)", margin: 0 }}
        >
          {labels.stats
            .replace("{count}", String(docCount))
            .replace("{folders}", String(folderCount))
            .replace("{authors}", String(authorCount))}
        </p>
      </div>
      <span style={{ flex: 1 }} />

      <label
        style={{
          alignItems: "center",
          background: MEGA_TOKENS.subtle,
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
          display: "flex",
          gap: MEGA_SPACING_TOKENS[6],
          minWidth: 260,
          padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
        }}
      >
        <span
          style={{
            clip: "rect(0 0 0 0)",
            clipPath: "inset(50%)",
            height: 1,
            overflow: "hidden",
            position: "absolute",
            width: 1,
          }}
        >
          {labels.searchAriaLabel}
        </span>
        <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="search" size={13} />
        <input
          data-mega-docs="search"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={labels.searchPlaceholder}
          ref={searchInputRef}
          style={{
            background: "transparent",
            border: "none",
            color: MEGA_TOKENS.text,
            flex: 1,
            fontFamily: "inherit",
            fontSize: "calc(var(--mega-density-font-size) - 0.5px)",
            minWidth: 0,
            outline: "none",
          }}
          value={search}
        />
        <KbdChip>⌘F</KbdChip>
      </label>

      <div
        aria-label={labels.viewAriaLabel}
        role="group"
        style={{
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {views.map((view, index) => (
          <button
            aria-pressed={Boolean(view.active)}
            disabled={!view.active}
            key={view.label}
            style={{
              alignItems: "center",
              background: view.active ? MEGA_TOKENS.activeBg : "transparent",
              border: "none",
              borderRight: index < views.length - 1 ? `1px solid ${MEGA_TOKENS.border}` : "none",
              cursor: view.active ? "default" : "not-allowed",
              display: "flex",
              opacity: view.active ? 1 : 0.5,
              padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
            }}
            title={view.active ? view.label : labels.deferredTooltip}
            type="button"
          >
            <DocsIcon
              aria-hidden="true"
              color={view.active ? MEGA_TOKENS.text : MEGA_TOKENS.muted}
              name={view.icon}
              size={13}
            />
            <span style={{ clipPath: "inset(50%)", height: 1, overflow: "hidden", position: "absolute", width: 1 }}>
              {view.label}
            </span>
          </button>
        ))}
      </div>

      <button
        data-mega-docs="sort"
        onClick={onSortToggle}
        style={{
          alignItems: "center",
          background: "transparent",
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
          color: MEGA_TOKENS.text,
          cursor: "pointer",
          display: "inline-flex",
          fontFamily: "inherit",
          fontSize: "calc(var(--mega-density-font-size) - 1.5px)",
          gap: MEGA_SPACING_TOKENS[5],
          padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
        }}
        type="button"
      >
        <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="filter" size={13} />
        {sort === "updated" ? labels.sortUpdated : labels.sortTitle}
      </button>

      <button
        data-mega-docs="header-new"
        onClick={onNewDoc}
        style={{
          alignItems: "center",
          background: MEGA_TOKENS.accent,
          border: "none",
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
          color: MEGA_TOKENS.accentForeground,
          cursor: "pointer",
          display: "inline-flex",
          fontFamily: "inherit",
          fontSize: "calc(var(--mega-density-font-size) - 1px)",
          fontWeight: 600,
          gap: MEGA_SPACING_TOKENS[6],
          padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
        }}
        type="button"
      >
        <DocsIcon aria-hidden="true" color="currentColor" name="plus" size={13} />
        {labels.newDoc}
      </button>
    </header>
  );
}
