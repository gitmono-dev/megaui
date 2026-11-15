// megaui:libs/react-shared/components/mega/composites/message-row.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream's body is a `MegaContentReader` (preset="chat") rendering
//   Lexical editor-state JSON via `resolveChatReaderStateJSON`; that
//   surface is UI-07's write set. `body` is plain `ReactNode` here.
// - The reaction row is the shared `ReactionsBar` composite (see that
//   module's header) instead of an inlined duplicate.
// - `ChatSystemMessage` and `ChatMessageQuote` are megaui-only additions
//   (this card's description calls for chat "bubble / system message /
//   quote" elements; upstream's `message-row.tsx` only covers the bubble
//   — system rows and quoted-reply previews are assembled ad hoc by the
//   upstream channel view, which is page-level and out of this card's
//   write set).
// - Styling moves from inline `MEGA_TOKENS` styles to Tailwind utilities
//   + the shadcn-style `Avatar`/`Badge` primitives (GC-02).
import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"
import { Badge } from "../ui/badge"
import { ReactionsBar, type ReactionsBarProps } from "./reactions-bar"

export interface ChatMessageAuthor {
  avatarInitials: string
  avatarUrl?: string
  displayName: string
  id: string
}

export type ChatMessageReactionsProps = ReactionsBarProps

export interface ChatMessageProps {
  after?: ReactNode
  author: ChatMessageAuthor
  body: ReactNode
  className?: string
  /** Shown next to the timestamp once `editedAt`-equivalent state is true (caller-supplied; GC-14). */
  editedLabel?: ReactNode
  /** Accessible label for the edit trigger (required with `onEdit`; GC-14). */
  editLabel?: string
  /** Consecutive message from the same author: hides the avatar/header. */
  grouped?: boolean
  id: string
  onEdit?(): void
  reactions?: ChatMessageReactionsProps
  /** Already-localized role chip, e.g. "Owner", "App" (caller-supplied; GC-14). */
  roleLabel?: ReactNode
  timestampLabel: ReactNode
}

/** One workspace-chat message row (CE-81 parity: chrome + body slot). */
export function ChatMessage({
  after,
  author,
  body,
  className,
  editedLabel,
  editLabel,
  grouped = false,
  id,
  onEdit,
  reactions,
  roleLabel,
  timestampLabel,
}: ChatMessageProps) {
  return (
    <div
      className={cn("group flex items-start gap-2 py-1", grouped ? "py-0.5" : "py-2", className)}
      data-message-grouped={grouped}
      data-message-id={id}
      data-slot="chat-message"
    >
      {grouped ? (
        <span aria-hidden="true" className="w-8 shrink-0" />
      ) : (
        <Avatar className="size-8 shrink-0">
          <AvatarImage alt="" src={author.avatarUrl} />
          <AvatarFallback>{author.avatarInitials}</AvatarFallback>
        </Avatar>
      )}

      <div className="min-w-0 flex-1">
        {!grouped && (
          <header className="flex flex-wrap items-baseline gap-1.5">
            <strong className="text-sm">{author.displayName}</strong>
            {roleLabel !== undefined && <Badge variant="secondary">{roleLabel}</Badge>}
            <span className="text-xs text-muted-foreground">
              {timestampLabel}
              {editedLabel !== undefined && <span data-slot="chat-message-edited"> {editedLabel}</span>}
            </span>
            {onEdit && editLabel !== undefined && (
              <button
                className="ml-auto text-xs text-muted-foreground hover:underline"
                data-slot="chat-message-edit"
                onClick={onEdit}
                type="button"
              >
                {editLabel}
              </button>
            )}
          </header>
        )}

        <div className="text-sm leading-relaxed" data-slot="chat-message-body">
          {body}
        </div>

        {reactions !== undefined && <ReactionsBar className="mt-1.5" {...reactions} />}
        {after !== undefined && <div className="mt-1.5">{after}</div>}
      </div>
    </div>
  )
}

export interface ChatSystemMessageProps {
  children: ReactNode
  className?: string
}

/** A centered, muted status line (join/leave/rename-style channel events). */
export function ChatSystemMessage({ children, className }: ChatSystemMessageProps) {
  return (
    <div
      className={cn("flex items-center justify-center py-1 text-xs text-muted-foreground", className)}
      data-slot="chat-system-message"
      role="status"
    >
      {children}
    </div>
  )
}

export interface ChatMessageQuoteProps {
  author: Pick<ChatMessageAuthor, "displayName">
  body: ReactNode
  /** Accessible label for the dismiss trigger (required with `onClear`; GC-14). */
  clearLabel?: string
  className?: string
  onClear?(): void
}

/** A quoted-reply preview shown above the composer while drafting a reply. */
export function ChatMessageQuote({ author, body, clearLabel, className, onClear }: ChatMessageQuoteProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border-l-2 border-l-primary bg-muted/40 px-2.5 py-1.5 text-sm",
        className
      )}
      data-slot="chat-message-quote"
    >
      <div className="min-w-0 flex-1">
        <strong className="text-xs text-muted-foreground">{author.displayName}</strong>
        <div className="truncate text-muted-foreground">{body}</div>
      </div>
      {onClear && clearLabel !== undefined && (
        <button
          aria-label={clearLabel}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClear}
          type="button"
        >
          ×
        </button>
      )}
    </div>
  )
}
