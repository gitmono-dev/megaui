import type { Issue } from "@megaui/core";
import { ReactionsBar } from "@megaui/ui/composites";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { ISSUE_REACTION_EMOJIS } from "../lib/issue-reactions";
import type { IssueBodySaveState } from "../hooks/use-issue-body-editor";
import { IssueMarkdown } from "../../components/issue-markdown";

interface IssueBodyPanelProps {
  readonly addReactionLabel: string;
  readonly autoSaveHint: string;
  readonly bodyDraft: string;
  readonly bodySaveState: IssueBodySaveState;
  readonly canEdit: boolean;
  readonly canReact: boolean;
  readonly editingBody: boolean;
  readonly editLabel: string;
  readonly emptyLabel: string;
  readonly finishEditingLabel: string;
  readonly issue: Issue;
  readonly placeholder: string;
  readonly savePending: boolean;
  readonly savedLabel: string;
  readonly saveFailedLabel: string;
  readonly savingLabel: string;
  readonly title: string;
  readonly onBodyChange: (value: string) => void;
  readonly onEditToggle: () => void;
  readonly onReaction: (emoji: string) => void;
}

export function IssueBodyPanel({
  addReactionLabel,
  autoSaveHint,
  bodyDraft,
  bodySaveState,
  canEdit,
  canReact,
  editingBody,
  editLabel,
  emptyLabel,
  finishEditingLabel,
  issue,
  placeholder,
  savePending,
  savedLabel,
  saveFailedLabel,
  savingLabel,
  title,
  onBodyChange,
  onEditToggle,
  onReaction,
}: IssueBodyPanelProps) {
  const bodySaveLabel = (() => {
    switch (bodySaveState) {
      case "saving":
        return savingLabel;
      case "saved":
        return savedLabel;
      case "error":
        return saveFailedLabel;
      case "idle":
        return autoSaveHint;
      default: {
        const unreachable: never = bodySaveState;
        return unreachable;
      }
    }
  })();

  return (
    <section
      data-mega-issues="body"
      style={{
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "8px" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{title}</h2>
        <span style={{ color: MEGA_TOKENS.muted }}>{issue.author.displayName} · {issue.createdAt}</span>
      </div>
      {canEdit ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: MEGA_SPACING_TOKENS[8],
            marginTop: MEGA_SPACING_TOKENS[6],
          }}
        >
          <button
            data-mega-issues="body-edit"
            disabled={savePending}
            onClick={onEditToggle}
            type="button"
          >
            {editingBody ? finishEditingLabel : editLabel}
          </button>
          {editingBody ? (
            <span
              data-mega-issues="body-save-state"
              data-state={bodySaveState}
              style={{ color: MEGA_TOKENS.muted }}
            >
              {bodySaveLabel}
            </span>
          ) : null}
        </div>
      ) : null}
      {editingBody ? (
        <textarea
          data-mega-issues="body-editor"
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder={placeholder}
          rows={8}
          style={{ marginTop: MEGA_SPACING_TOKENS[6], width: "100%" }}
          value={bodyDraft}
        />
      ) : (
        <div data-mega-issues="body-text" style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
          {issue.body?.trim() ? <IssueMarkdown text={issue.body} /> : emptyLabel}
        </div>
      )}
      {canReact || issue.reactions.length > 0 ? (
        <div data-mega-issues="issue-reactions" style={{ marginTop: MEGA_SPACING_TOKENS[8] }}>
          <ReactionsBar
            addAction={
              canReact
                ? {
                    emojiOptions: ISSUE_REACTION_EMOJIS,
                    label: addReactionLabel,
                    onAdd: onReaction,
                  }
                : undefined
            }
            onReactionToggle={canReact ? (reaction) => onReaction(reaction.emoji) : undefined}
            reactions={issue.reactions}
          />
        </div>
      ) : null}
    </section>
  );
}
