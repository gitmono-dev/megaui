import type { Issue } from "@megaui/core";
import { CommentThread } from "@megaui/ui/composites";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { ISSUE_REACTION_EMOJIS } from "../lib/issue-reactions";
import type { IssueBodySaveState } from "../hooks/use-issue-body-editor";
import { IssueMarkdown } from "../../components/issue-markdown";

interface IssueBodyPanelProps {
  readonly addReactionLabel: string;
  readonly autoSaveHint: string;
  readonly authorRoleLabel: string;
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
  authorRoleLabel,
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
    <section data-mega-issues="body" aria-label={title} style={{ marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      <div data-mega-issues={canReact || issue.reactions.length > 0 ? "issue-reactions" : undefined}>
        <CommentThread
          id={`issue-${issue.id}`}
          author={issue.author}
          roleLabel={authorRoleLabel}
          timestampLabel={issue.createdAt}
          action={canEdit ? (
            <div style={{ display: "flex", alignItems: "center", gap: MEGA_SPACING_TOKENS[6] }}>
              {editingBody && <span data-mega-issues="body-save-state" data-state={bodySaveState} style={{ color: MEGA_TOKENS.muted }}>{bodySaveLabel}</span>}
              <button data-mega-issues="body-edit" disabled={savePending} onClick={onEditToggle} type="button">
                {editingBody ? finishEditingLabel : editLabel}
              </button>
            </div>
          ) : undefined}
          body={editingBody ? (
            <textarea data-mega-issues="body-editor" onChange={event => onBodyChange(event.target.value)}
              placeholder={placeholder} rows={8} style={{ width: "100%" }} value={bodyDraft} />
          ) : (
            <div data-mega-issues="body-text">{issue.body?.trim() ? <IssueMarkdown text={issue.body} /> : emptyLabel}</div>
          )}
          reactions={canReact || issue.reactions.length > 0 ? {
            addAction: canReact ? { emojiOptions: ISSUE_REACTION_EMOJIS, label: addReactionLabel, onAdd: onReaction } : undefined,
            onReactionToggle: canReact ? reaction => onReaction(reaction.emoji) : undefined,
            reactions: issue.reactions,
          } : undefined}
        />
      </div>
    </section>
  );
}
