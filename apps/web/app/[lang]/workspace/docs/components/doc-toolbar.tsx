"use client";

import Link from "next/link";
import { useState } from "react";

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_SURFACE_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import type { DocWriterChrome } from "./doc-writer";
import { DocsIcon } from "./docs-icons";

export interface DocToolbarLabels {
  breadcrumbDocs: string;
  deferredTooltip: string;
  edit: string;
  exportDoc: string;
  history: string;
  rename: string;
  renameAriaLabel: string;
  renameCancel: string;
  renameSave: string;
  share: string;
  starAriaLabel: string;
  unstarAriaLabel: string;
}

export interface DocToolbarProps {
  crumbTag?: string;
  docsHref: string;
  editHref: string;
  isStarred: boolean;
  labels: DocToolbarLabels;
  publication?: { label: string; busy: boolean; disabled: boolean; onClick(): void };
  onRename?(title: string): Promise<void>;
  onShare(): void;
  onStar(): void;
  showEditEntry: boolean;
  starring: boolean;
  title: string;
  writerChrome?: DocWriterChrome | null;
}

const chipStyle = {
  alignItems: "center",
  background: "transparent",
  border: `1px solid ${MEGA_TOKENS.border}`,
  borderRadius: MEGA_SURFACE_TOKENS.controlRadius,
  color: MEGA_TOKENS.text,
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: "inherit",
  fontSize: MEGA_SURFACE_TOKENS.controlFontSize,
  gap: MEGA_SPACING_TOKENS[5],
  padding: `${MEGA_SPACING_TOKENS[5]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[3]})`,
  textDecoration: "none",
} as const;

const statusChipStyle = {
  border: `1px solid ${MEGA_TOKENS.border}`,
  borderRadius: MEGA_RADIUS_TOKENS.pill,
  fontSize: "calc(var(--mega-density-font-size) - 2.5px)",
  padding: `${MEGA_SPACING_TOKENS[1]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
} as const;

/** DC-02 toolbar: breadcrumb, fail-closed share, star, deferred history/export, edit-entry. */
export function DocToolbar({
  crumbTag,
  docsHref,
  editHref,
  isStarred,
  labels,
  onRename,
  publication,
  onShare,
  onStar,
  showEditEntry,
  starring,
  title,
  writerChrome,
}: DocToolbarProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);

  const submitRename = async (rawTitle: string) => {
    if (!onRename) return;
    const next = rawTitle.trim();
    if (!next || next === title) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    try {
      await onRename(next);
      setRenaming(false);
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <header
      data-mega-docs="chrome"
      style={{
        alignItems: "center",
        background: MEGA_TOKENS.bg,
        borderBottom: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        flexWrap: "wrap",
        gap: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]}) calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
      }}
    >
      <nav
        style={{
          alignItems: "center",
          color: MEGA_TOKENS.muted,
          display: "flex",
          flex: "1 1 240px",
          fontSize: MEGA_SURFACE_TOKENS.fieldFontSize,
          gap: MEGA_SPACING_TOKENS[4],
          minWidth: 0,
        }}
      >
        <Link href={docsHref} style={{ color: MEGA_TOKENS.accent, textDecoration: "none" }}>
          {labels.breadcrumbDocs}
        </Link>
        {crumbTag ? (
          <>
            <span aria-hidden="true">/</span>
            <span>{crumbTag}</span>
          </>
        ) : null}
        <span aria-hidden="true">/</span>
        {renaming ? (
          <form
            data-mega-docs="rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void submitRename(String(data.get("title") ?? ""));
            }}
            style={{ alignItems: "center", display: "inline-flex", gap: MEGA_SPACING_TOKENS[4], minWidth: 0 }}
          >
            <input
              aria-label={labels.renameAriaLabel}
              autoFocus
              data-mega-docs="rename-input"
              defaultValue={title}
              disabled={renameBusy}
              key={`rename-${title}`}
              name="title"
              style={{
                background: MEGA_TOKENS.bg,
                border: `1px solid ${MEGA_TOKENS.border}`,
                borderRadius: MEGA_RADIUS_TOKENS.md,
                color: MEGA_TOKENS.text,
                fontFamily: "inherit",
                fontSize: "inherit",
                maxWidth: 280,
                padding: `${MEGA_SPACING_TOKENS[1]} ${MEGA_SPACING_TOKENS[6]}`,
              }}
            />
            <button data-mega-docs="rename-submit" disabled={renameBusy} style={{ ...chipStyle, color: MEGA_TOKENS.accent }} type="submit">
              {labels.renameSave}
            </button>
            <button
              data-mega-docs="rename-cancel"
              disabled={renameBusy}
              onClick={() => setRenaming(false)}
              style={chipStyle}
              type="button"
            >
              {labels.renameCancel}
            </button>
          </form>
        ) : (
          <span
            style={{
              color: MEGA_TOKENS.text,
              fontWeight: 600,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
        )}
      </nav>

      {onRename && !renaming ? (
        <button data-mega-docs="rename-entry" onClick={() => setRenaming(true)} style={chipStyle} type="button">
          {labels.rename}
        </button>
      ) : null}

      <button
        aria-label={(isStarred ? labels.unstarAriaLabel : labels.starAriaLabel).replace("{title}", title)}
        aria-pressed={isStarred}
        data-mega-docs="star"
        data-starred={isStarred ? "true" : "false"}
        disabled={starring}
        onClick={onStar}
        style={chipStyle}
        type="button"
      >
        <DocsIcon color={isStarred ? MEGA_TOKENS.warning : MEGA_TOKENS.muted} name="star" size={13} />
      </button>

      {publication ? (
        <button
          data-mega-docs="publication"
          aria-busy={publication.busy}
          disabled={publication.disabled}
          onClick={publication.onClick}
          style={{ ...chipStyle, background: MEGA_TOKENS.accent, color: "white", opacity: publication.disabled ? 0.6 : 1,
            cursor: publication.disabled ? "not-allowed" : "pointer" }}
          type="button"
        >
          {publication.label}
        </button>
      ) : null}
      <button data-mega-docs="share" onClick={onShare} style={chipStyle} type="button">
        {labels.share}
      </button>
      <button disabled style={{ ...chipStyle, cursor: "not-allowed", opacity: 0.5 }} title={labels.deferredTooltip} type="button">
        {labels.history}
      </button>
      <button disabled style={{ ...chipStyle, cursor: "not-allowed", opacity: 0.5 }} title={labels.deferredTooltip} type="button">
        {labels.exportDoc}
      </button>
      {writerChrome ? (
        <>
          <span
            data-mega-docs="save-state"
            data-state={writerChrome.saveState}
            role="status"
            style={{
              ...statusChipStyle,
              background:
                writerChrome.saveState === "saved"
                  ? `color-mix(in srgb, ${MEGA_TOKENS.success} 11%, transparent)`
                  : MEGA_TOKENS.subtle,
              color: writerChrome.saveState === "saved" ? MEGA_TOKENS.success : MEGA_TOKENS.muted,
            }}
          >
            {writerChrome.saveLabel}
          </span>
          <span
            data-mega-docs="collab-mode"
            data-mode={writerChrome.collabMode}
            style={{
              ...statusChipStyle,
              background: MEGA_TOKENS.subtle,
              color: MEGA_TOKENS.muted,
            }}
          >
            {writerChrome.collabLabel}
          </span>
        </>
      ) : null}
      {showEditEntry ? (
        <Link
          data-mega-docs="edit-entry"
          href={editHref}
          style={{
            alignItems: "center",
            background: MEGA_TOKENS.accent,
            borderRadius: MEGA_SURFACE_TOKENS.controlRadius,
            color: MEGA_TOKENS.accentForeground,
            display: "inline-flex",
            fontSize: MEGA_SURFACE_TOKENS.controlFontSize,
            fontWeight: 600,
            gap: MEGA_SPACING_TOKENS[5],
            padding: `${MEGA_SPACING_TOKENS[5]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
            textDecoration: "none",
          }}
        >
          <DocsIcon aria-hidden="true" color="currentColor" name="edit" size={12} /> {labels.edit}
        </Link>
      ) : null}
    </header>
  );
}
