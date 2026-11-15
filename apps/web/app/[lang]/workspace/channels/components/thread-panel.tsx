"use client";

import type { ChatMessage as ChatMessageModel } from "@megaui/core";
import { ChatMessage } from "@megaui/ui/composites";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { ChatComposer } from "./chat-composer";
import { messagePlainText } from "./message-body";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function ThreadPanel({
  closeLabel,
  loading,
  loadingLabel,
  notFoundMessage,
  onClose,
  onReply,
  replyAriaLabel,
  replyPlaceholder,
  sendAriaLabel,
  sending,
  threadMessages,
  title,
}: {
  closeLabel: string;
  loading?: boolean;
  loadingLabel: string;
  notFoundMessage?: string;
  onClose: () => void;
  onReply: (body: string) => void | Promise<void>;
  replyAriaLabel: string;
  replyPlaceholder: string;
  sendAriaLabel: string;
  sending?: boolean;
  threadMessages: readonly ChatMessageModel[];
  title: string;
}) {
  return (
    <aside
      data-mega-chat="thread-panel"
      style={{
        borderLeft: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        flexDirection: "column",
        gap: MEGA_SPACING_TOKENS[8],
        maxWidth: 360,
        minWidth: 280,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <header style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{title}</h2>
        <button aria-label={closeLabel} data-mega-chat="thread-close" onClick={onClose} type="button">
          {closeLabel}
        </button>
      </header>

      {loading ? <p>{loadingLabel}</p> : null}
      {notFoundMessage ? (
        <p data-mega-chat="thread-not-found" role="alert">
          {notFoundMessage}
        </p>
      ) : null}

      <div data-mega-chat="thread-messages" style={{ flex: 1, overflow: "auto" }}>
        {threadMessages.map((message) => (
          <ChatMessage
            author={{
              id: message.author.id,
              displayName: message.author.displayName,
              avatarInitials: message.author.avatarInitials,
              avatarUrl: message.author.avatarUrl,
            }}
            body={messagePlainText(message)}
            id={message.id}
            key={message.id}
            timestampLabel={formatTime(message.createdAt)}
          />
        ))}
      </div>

      <ChatComposer
        disabled={sending}
        onSend={onReply}
        placeholder={replyPlaceholder}
        sendAriaLabel={sendAriaLabel}
        testId="thread-composer"
      />
      <span className="sr-only">{replyAriaLabel}</span>
    </aside>
  );
}
