"use client";

import type { DocComment } from "@megaui/core";
import { CommentThread } from "@megaui/ui/composites";
import { MEGA_SPACING_TOKENS, MEGA_SURFACE_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { RelativeTime } from "./relative-time";

export interface DocCommentsLabels {
  authorRole: string;
  composer: {
    placeholder: string;
    submit: string;
    submitting: string;
  };
  empty: string;
  title: string;
}

export interface DocCommentsProps {
  authorId: string;
  comments: readonly DocComment[] | undefined;
  draft: string;
  labels: DocCommentsLabels;
  loading: boolean;
  loadingLabel: string;
  locale: string;
  now: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  showComposer: boolean;
  submitting: boolean;
}

/** Comments sit under the outliner, in a library-card surface. */
export function DocComments({
  authorId,
  comments,
  draft,
  labels,
  loading,
  loadingLabel,
  locale,
  now,
  onDraftChange,
  onSubmit,
  showComposer,
  submitting,
}: DocCommentsProps) {
  return (
    <section
      data-mega-docs="comments"
      style={{
        background: MEGA_TOKENS.bg,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_SURFACE_TOKENS.panelRadius,
        marginBottom: `calc(${MEGA_SPACING_TOKENS[8]} * 6)`,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) calc(${MEGA_SPACING_TOKENS[8]} * 2.5)`,
      }}
    >
      <h2
        style={{
          color: MEGA_TOKENS.text,
          fontSize: MEGA_SURFACE_TOKENS.sectionTitleSize,
          fontWeight: 700,
          margin: `0 0 ${MEGA_SPACING_TOKENS[8]}`,
        }}
      >
        {labels.title.replace("{count}", String(comments?.length ?? 0))}
      </h2>
      {loading ? <p style={{ color: MEGA_TOKENS.muted }}>{loadingLabel}</p> : null}
      {!loading && comments && comments.length === 0 ? (
        <p data-mega-docs="comments-empty" style={{ color: MEGA_TOKENS.muted, margin: 0 }}>
          {labels.empty}
        </p>
      ) : null}
      {comments?.map((comment) => (
        <div
          data-mega-docs="comment"
          key={comment.id}
          style={{
            borderTop: `1px solid ${MEGA_TOKENS.border}`,
            marginTop: MEGA_SPACING_TOKENS[8],
            paddingTop: MEGA_SPACING_TOKENS[8],
          }}
        >
          <CommentThread
            author={comment.author}
            body={comment.body}
            id={comment.id}
            roleLabel={comment.author.id === authorId ? labels.authorRole : undefined}
            timestampLabel={<RelativeTime locale={locale} now={now} value={comment.createdAt} />}
          />
        </div>
      ))}
      {showComposer ? (
        <section
          data-mega-docs="composer"
          style={{
            background: MEGA_TOKENS.subtle,
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_SURFACE_TOKENS.controlRadius,
            marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
            padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
          }}
        >
          <textarea
            data-mega-docs="comment-draft"
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={labels.composer.placeholder}
            rows={4}
            style={{
              background: "transparent",
              border: "none",
              color: MEGA_TOKENS.text,
              fontFamily: "inherit",
              fontSize: MEGA_SURFACE_TOKENS.fieldFontSize,
              outline: "none",
              resize: "vertical",
              width: "100%",
            }}
            value={draft}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: MEGA_SPACING_TOKENS[8] }}>
            <button
              data-mega-docs="comment-submit"
              disabled={submitting || !draft.trim()}
              onClick={onSubmit}
              style={{
                background: MEGA_TOKENS.accent,
                border: "none",
                borderRadius: MEGA_SURFACE_TOKENS.controlRadius,
                color: MEGA_TOKENS.accentForeground,
                cursor: submitting || !draft.trim() ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                fontSize: MEGA_SURFACE_TOKENS.controlFontSize,
                fontWeight: 600,
                opacity: submitting || !draft.trim() ? 0.55 : 1,
                padding: `${MEGA_SPACING_TOKENS[5]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
              }}
              type="button"
            >
              {submitting ? labels.composer.submitting : labels.composer.submit}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
