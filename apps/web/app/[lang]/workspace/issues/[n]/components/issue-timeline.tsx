import type { IssueComment } from "@megaui/core";
import { CommentThread } from "@megaui/ui/composites";
import { MEGA_SPACING_TOKENS } from "@megaui/ui/tokens";

import { ISSUE_REACTION_EMOJIS } from "../lib/issue-reactions";

interface IssueTimelineProps {
  readonly addReactionLabel: string;
  readonly authorRoleLabel: string;
  readonly canReact: boolean;
  readonly comments: readonly IssueComment[] | undefined;
  readonly errorLabel: string;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly issueAuthorId: string;
  readonly loadingLabel: string;
  readonly retryLabel: string;
  readonly onCommentReaction: (input: {
    readonly commentId: string;
    readonly emoji: string;
  }) => void;
  readonly onRetry: () => void;
}

export function IssueTimeline({
  addReactionLabel,
  authorRoleLabel,
  canReact,
  comments,
  errorLabel,
  isError,
  isPending,
  issueAuthorId,
  loadingLabel,
  retryLabel,
  onCommentReaction,
  onRetry,
}: IssueTimelineProps) {
  return (
    <section
      data-mega-issues="timeline"
      style={{ marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
    >
      {isPending ? <p>{loadingLabel}</p> : null}
      {isError ? (
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{errorLabel}</p>
          <button data-mega-issues="retry" onClick={onRetry} type="button">
            {retryLabel}
          </button>
        </div>
      ) : null}
      {comments?.map((comment) => (
        <div
          data-mega-issues="comment"
          key={comment.id}
          style={{ marginBottom: MEGA_SPACING_TOKENS[8] }}
        >
          <CommentThread
            author={comment.author}
            body={comment.body}
            id={comment.id}
            reactions={
              canReact || comment.reactions.length > 0
                ? {
                    addAction: canReact
                      ? {
                          emojiOptions: ISSUE_REACTION_EMOJIS,
                          label: addReactionLabel,
                          onAdd: (emoji) => onCommentReaction({ commentId: comment.id, emoji }),
                        }
                      : undefined,
                    onReactionToggle: canReact
                      ? (reaction) =>
                          onCommentReaction({ commentId: comment.id, emoji: reaction.emoji })
                      : undefined,
                    reactions: comment.reactions,
                  }
                : undefined
            }
            roleLabel={comment.author.id === issueAuthorId ? authorRoleLabel : undefined}
            timestampLabel={comment.createdAt}
          />
        </div>
      ))}
    </section>
  );
}
