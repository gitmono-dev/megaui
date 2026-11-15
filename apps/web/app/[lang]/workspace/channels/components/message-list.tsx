"use client";

import { useEffect, useRef, useState } from "react";

import type { ChatMessage as ChatMessageModel, Reaction } from "@megaui/core";
import { ChatMessage } from "@megaui/ui/composites";
import { useFixedRowVirtualizer } from "@megaui/ui/file-tree";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { messagePlainText } from "./message-body";

const ROW_HEIGHT = 96;
const VIRTUALIZE_THRESHOLD = 60;
const REACTION_EMOJIS = ["👍", "🎉", "🚀", "❤️"] as const;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function MessageList({
  cancelEditLabel,
  editedLabel,
  editLabel,
  jumpToLatestLabel,
  listAriaLabel,
  messages,
  onEdit,
  onOpenThread,
  onReaction,
  reactionAddLabel,
  saveEditLabel,
  selfUserId,
  threadRepliesLabel,
  threadRoots,
}: {
  cancelEditLabel?: string;
  editedLabel: string;
  editLabel?: string;
  jumpToLatestLabel: string;
  listAriaLabel: string;
  messages: readonly ChatMessageModel[];
  onEdit?: (messageId: string, body: string) => unknown;
  onOpenThread?: (rootMessageId: string) => void;
  onReaction: (messageId: string, emoji: string) => void;
  reactionAddLabel: string;
  saveEditLabel?: string;
  selfUserId?: string;
  threadRepliesLabel: (count: number) => string;
  threadRoots?: ReadonlyMap<string, number>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const virtualize = messages.length >= VIRTUALIZE_THRESHOLD;

  const virtualizer = useFixedRowVirtualizer({
    count: virtualize ? messages.length : 0,
    getScrollElement: () => scrollRef.current,
    rowHeight: ROW_HEIGHT,
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !virtualize) {
      setShowJump(false);
      return;
    }
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setShowJump(distance > ROW_HEIGHT * 3);
    };
    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [virtualize, messages.length]);

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    if (virtualize) {
      virtualizer.scrollToIndex(Math.max(0, messages.length - 1));
    } else {
      element.scrollTop = element.scrollHeight;
    }
  };

  const renderRow = (message: ChatMessageModel, index: number) => {
    const prev = index > 0 ? messages[index - 1] : undefined;
    const grouped = Boolean(prev && prev.author.id === message.author.id);
    const replyCount = threadRoots?.get(message.id) ?? 0;
    const reactions = {
      reactions: message.reactions as Reaction[],
      onReactionToggle: (reaction: Reaction) => onReaction(message.id, reaction.emoji),
      addAction: {
        label: reactionAddLabel,
        emojiOptions: REACTION_EMOJIS,
        onAdd: (emoji: string) => onReaction(message.id, emoji),
      },
    };
    const canEdit = Boolean(onEdit && selfUserId && message.author.id === selfUserId && editLabel);

    if (editingId === message.id) {
      return (
        <div data-mega-chat="message-row" data-message-id={message.id} style={{ minHeight: ROW_HEIGHT }}>
          <textarea
            data-mega-chat="message-edit-input"
            onChange={(event) => setDraft(event.target.value)}
            style={{ display: "block", minHeight: 64, width: "100%" }}
            value={draft}
          />
          <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], marginTop: MEGA_SPACING_TOKENS[8] }}>
            <button
              data-mega-chat="message-edit-save"
              disabled={!draft.trim()}
              onClick={() => {
                void Promise.resolve(onEdit?.(message.id, draft.trim())).then(() => {
                  setEditingId(null);
                  setDraft("");
                });
              }}
              type="button"
            >
              {saveEditLabel}
            </button>
            <button
              data-mega-chat="message-edit-cancel"
              onClick={() => {
                setEditingId(null);
                setDraft("");
              }}
              type="button"
            >
              {cancelEditLabel}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div data-mega-chat="message-row" data-message-id={message.id} style={{ minHeight: ROW_HEIGHT }}>
        {canEdit ? (
          <button
            data-mega-chat="message-edit"
            onClick={() => {
              setEditingId(message.id);
              setDraft(messagePlainText(message));
            }}
            style={{ background: "none", border: "none", color: MEGA_TOKENS.muted, cursor: "pointer", padding: 0 }}
            type="button"
          >
            {editLabel}
          </button>
        ) : null}
        <ChatMessage
          after={
            replyCount > 0 && onOpenThread ? (
              <button
                data-mega-chat="thread-open"
                onClick={() => onOpenThread(message.id)}
                style={{ background: "none", border: "none", color: MEGA_TOKENS.accent, cursor: "pointer", padding: 0 }}
                type="button"
              >
                {threadRepliesLabel(replyCount)}
              </button>
            ) : onOpenThread ? (
              <button
                data-mega-chat="thread-open"
                onClick={() => onOpenThread(message.id)}
                style={{ background: "none", border: "none", color: MEGA_TOKENS.muted, cursor: "pointer", padding: 0 }}
                type="button"
              >
                {threadRepliesLabel(0)}
              </button>
            ) : undefined
          }
          author={{
            id: message.author.id,
            displayName: message.author.displayName,
            avatarInitials: message.author.avatarInitials,
            avatarUrl: message.author.avatarUrl,
          }}
          body={messagePlainText(message)}
          editedLabel={message.editedAt ? editedLabel : undefined}
          grouped={grouped}
          id={message.id}
          reactions={reactions}
          timestampLabel={formatTime(message.createdAt)}
        />
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0, position: "relative" }}>
      <div
        aria-label={listAriaLabel}
        data-mega-chat="message-list"
        data-virtualized={virtualize ? "true" : "false"}
        ref={scrollRef}
        role="log"
        style={{ flex: 1, minHeight: 280, overflow: "auto", paddingRight: MEGA_SPACING_TOKENS[8] }}
      >
        {virtualize ? (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const message = messages[row.index];
              if (!message) return null;
              return (
                <div
                  key={message.id}
                  style={{
                    left: 0,
                    minHeight: ROW_HEIGHT,
                    overflow: "visible",
                    position: "absolute",
                    right: 0,
                    top: row.start,
                  }}
                >
                  {renderRow(message, row.index)}
                </div>
              );
            })}
          </div>
        ) : (
          messages.map((message, index) => <div key={message.id}>{renderRow(message, index)}</div>)
        )}
      </div>
      {showJump ? (
        <button
          data-mega-chat="jump-to-latest"
          onClick={jumpToLatest}
          style={{
            background: MEGA_TOKENS.accent,
            border: "none",
            borderRadius: 999,
            bottom: MEGA_SPACING_TOKENS[8],
            color: MEGA_TOKENS.accentForeground,
            cursor: "pointer",
            padding: `${MEGA_SPACING_TOKENS[8]} calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
            position: "absolute",
            right: MEGA_SPACING_TOKENS[8],
          }}
          type="button"
        >
          {jumpToLatestLabel}
        </button>
      ) : null}
    </div>
  );
}
