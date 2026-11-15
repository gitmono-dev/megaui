"use client";

import { useEffect, useRef, useState } from "react";

import type { Folder } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { UNSORTED_FOLDER_ID } from "./docs-filter";

export interface NewDocDialogLabels {
  cancel: string;
  folderLabel: string;
  submit: string;
  submitting: string;
  title: string;
  titleLabel: string;
  titlePlaceholder: string;
}

export interface NewDocDialogProps {
  errorMessage: string | null;
  folders: readonly Folder[];
  labels: NewDocDialogLabels;
  onOpenChange(open: boolean): void;
  onSubmit(input: { folderId?: string; title: string }): void;
  open: boolean;
  submitting: boolean;
}

/** Title + optional derived folder. Create still lands on the reader (WA-12). */
export function NewDocDialog({ errorMessage, folders, labels, onOpenChange, onSubmit, open, submitting }: NewDocDialogProps) {
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const realFolders = folders.filter((folder) => folder.id !== UNSORTED_FOLDER_ID);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setFolderId("");
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-mega-docs="new-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      role="dialog"
      style={{
        background: "color-mix(in srgb, var(--mega-text) 32%, transparent)",
        inset: 0,
        position: "fixed",
        zIndex: 40,
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = title.trim();
          if (!trimmed || submitting) return;
          onSubmit({
            folderId: folderId || undefined,
            title: trimmed,
          });
        }}
        style={{
          background: MEGA_TOKENS.bg,
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 3)`,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          left: "50%",
          maxWidth: 440,
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.5)`,
          position: "absolute",
          top: "22%",
          transform: "translateX(-50%)",
          width: "90%",
        }}
      >
        <h2
          style={{
            color: MEGA_TOKENS.text,
            fontSize: "calc(var(--mega-density-font-size) + 2px)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          {labels.title}
        </h2>
        <label
          style={{
            color: MEGA_TOKENS.muted,
            display: "block",
            fontSize: "calc(var(--mega-density-font-size) - 2px)",
            fontWeight: 600,
            marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
          }}
        >
          {labels.titleLabel}
          <input
            data-mega-docs="new-title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder={labels.titlePlaceholder}
            ref={titleRef}
            required
            style={{
              background: MEGA_TOKENS.subtle,
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.5)`,
              color: MEGA_TOKENS.text,
              display: "block",
              fontFamily: "inherit",
              fontSize: "var(--mega-density-font-size)",
              marginTop: MEGA_SPACING_TOKENS[4],
              padding: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[8]}`,
              width: "100%",
            }}
            value={title}
          />
        </label>
        {errorMessage ? (
          <p
            data-mega-docs="new-error"
            role="alert"
            style={{ color: MEGA_TOKENS.danger, fontSize: "calc(var(--mega-density-font-size) - 1px)", margin: `${MEGA_SPACING_TOKENS[4]} 0 0` }}
          >
            {errorMessage}
          </p>
        ) : null}
        {realFolders.length > 0 ? (
          <label
            style={{
              color: MEGA_TOKENS.muted,
              display: "block",
              fontSize: "calc(var(--mega-density-font-size) - 2px)",
              fontWeight: 600,
              marginTop: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
            }}
          >
            {labels.folderLabel}
            <select
              data-mega-docs="new-folder"
              onChange={(event) => setFolderId(event.target.value)}
              style={{
                background: MEGA_TOKENS.subtle,
                border: `1px solid ${MEGA_TOKENS.border}`,
                borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.5)`,
                color: MEGA_TOKENS.text,
                display: "block",
                fontFamily: "inherit",
                fontSize: "var(--mega-density-font-size)",
                marginTop: MEGA_SPACING_TOKENS[4],
                padding: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[8]}`,
                width: "100%",
              }}
              value={folderId}
            >
              <option value="">{realFolders.length > 0 ? "—" : ""}</option>
              {realFolders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div
          style={{
            display: "flex",
            gap: MEGA_SPACING_TOKENS[8],
            justifyContent: "flex-end",
            marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2.5)`,
          }}
        >
          <button
            onClick={() => onOpenChange(false)}
            style={{
              background: "transparent",
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
              color: MEGA_TOKENS.text,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "calc(var(--mega-density-font-size) - 1px)",
              padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
            }}
            type="button"
          >
            {labels.cancel}
          </button>
          <button
            data-mega-docs="new-submit"
            disabled={submitting || !title.trim()}
            style={{
              background: MEGA_TOKENS.accent,
              border: "none",
              borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
              color: MEGA_TOKENS.accentForeground,
              cursor: submitting ? "wait" : "pointer",
              fontFamily: "inherit",
              fontSize: "calc(var(--mega-density-font-size) - 1px)",
              fontWeight: 600,
              padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
            }}
            type="submit"
          >
            {submitting ? labels.submitting : labels.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
