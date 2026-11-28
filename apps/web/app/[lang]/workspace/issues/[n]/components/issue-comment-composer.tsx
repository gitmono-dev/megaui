import { useState } from "react";
import { useTranslation } from "@/hooks/use-translation";
import { IssueMarkdown } from "../../components/issue-markdown";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface IssueCommentComposerProps {
  readonly closeLabel: string;
  readonly closePending: boolean;
  readonly comment: string;
  readonly commentPending: boolean;
  readonly placeholder: string;
  readonly reopenLabel: string;
  readonly reopenPending: boolean;
  readonly state: "open" | "closed";
  readonly submitLabel: string;
  readonly submittingLabel: string;
  readonly onClose: () => void;
  readonly onCommentChange: (value: string) => void;
  readonly onReopen: () => void;
  readonly onSubmit: () => void;
}

export function IssueCommentComposer({
  closeLabel,
  closePending,
  comment,
  commentPending,
  placeholder,
  reopenLabel,
  reopenPending,
  state,
  submitLabel,
  submittingLabel,
  onClose,
  onCommentChange,
  onReopen,
  onSubmit,
}: IssueCommentComposerProps) {
  const [preview, setPreview] = useState(false);
  const labels = useTranslation().t.workspace.issues.create;
  return (
    <section
      data-mega-issues="composer"
      style={{
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <div role="group" aria-label={labels.descriptionLabel} style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>{labels.write}</button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>{labels.preview}</button>
      </div>
      {preview ? <div style={{ minHeight: "96px" }}>{comment.trim() ? <IssueMarkdown text={comment} /> : labels.emptyPreview}</div> : <textarea
        data-mega-issues="comment-draft"
        onChange={(event) => onCommentChange(event.target.value)}
        placeholder={placeholder}
        rows={4}
        style={{ width: "100%" }}
        value={comment}
      />}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: MEGA_SPACING_TOKENS[8],
          marginTop: MEGA_SPACING_TOKENS[8],
        }}
      >
        <button
          data-mega-issues="comment-submit"
          disabled={commentPending || !comment.trim()}
          onClick={onSubmit}
          type="button"
        >
          {commentPending ? submittingLabel : submitLabel}
        </button>
        {state === "open" ? (
          <button data-mega-issues="close" disabled={closePending} onClick={onClose} type="button">
            {closeLabel}
          </button>
        ) : (
          <button
            data-mega-issues="reopen"
            disabled={reopenPending}
            onClick={onReopen}
            type="button"
          >
            {reopenLabel}
          </button>
        )}
      </div>
    </section>
  );
}
