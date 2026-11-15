"use client";

import type { User } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export interface DocShareDialogLabels {
  close: string;
  collaboratorsEmpty: string;
  collaboratorsHeading: string;
  copied: string;
  copyFailed: string;
  copyLink: string;
  defaultOpenNote: string;
  title: string;
}

export interface DocShareDialogProps {
  collaborators: readonly User[];
  labels: DocShareDialogLabels;
  onClose(): void;
  onCopied(ok: boolean): void;
}

/** Fail-closed share sheet — copy link only; access is not default-open. */
export function DocShareDialog({ collaborators, labels, onClose, onCopied }: DocShareDialogProps) {
  return (
    <div
      data-mega-docs="share-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      style={{
        background: "color-mix(in srgb, var(--mega-text) 32%, transparent)",
        inset: 0,
        position: "fixed",
        zIndex: 40,
      }}
    >
      <div
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
            fontSize: "calc(var(--mega-density-font-size) + 3px)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          {labels.title}
        </h2>
        <p data-mega-docs="share-note" style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
          {labels.defaultOpenNote}
        </p>
        <h3
          style={{
            color: MEGA_TOKENS.text,
            fontSize: "calc(var(--mega-density-font-size) - 0.5px)",
            fontWeight: 650,
            margin: `${MEGA_SPACING_TOKENS[8]} 0 ${MEGA_SPACING_TOKENS[6]}`,
          }}
        >
          {labels.collaboratorsHeading}
        </h3>
        {collaborators.length === 0 ? (
          <p data-mega-docs="share-empty" style={{ color: MEGA_TOKENS.muted, margin: 0 }}>
            {labels.collaboratorsEmpty}
          </p>
        ) : (
          <ul data-mega-docs="share-collaborators" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {collaborators.map((user) => (
              <li key={user.id} style={{ color: MEGA_TOKENS.text, padding: `${MEGA_SPACING_TOKENS[3]} 0` }}>
                {user.displayName}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], justifyContent: "flex-end", marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
          <button
            data-mega-docs="copy-link"
            onClick={async () => {
              const url = typeof window !== "undefined" ? (window.location.href.split("?")[0] ?? "") : "";
              try {
                await navigator.clipboard.writeText(url);
                onCopied(true);
              } catch {
                onCopied(false);
              }
              onClose();
            }}
            style={{
              background: MEGA_TOKENS.accent,
              border: "none",
              borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.75)`,
              color: MEGA_TOKENS.accentForeground,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "calc(var(--mega-density-font-size) - 1px)",
              fontWeight: 600,
              padding: `${MEGA_SPACING_TOKENS[6]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
            }}
            type="button"
          >
            {labels.copyLink}
          </button>
          <button
            onClick={onClose}
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
            {labels.close}
          </button>
        </div>
      </div>
    </div>
  );
}
