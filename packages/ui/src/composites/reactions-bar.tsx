"use client"

// megaui:libs/react-shared/components/mega/composites/comment-card.tsx@0ff3a9d (extracted)
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream inlines this exact reaction-pill + "add reaction" pattern
//   twice, once in `comment-card.tsx` and once (byte-for-byte identical) in
//   `message-row.tsx`. This card extracts it into one standalone composite
//   (GC-02 single source of truth) so `CommentThread` and `ChatMessage`
//   both consume it instead of duplicating the reducer-free toggle/add
//   logic a second time.
// - Styling moves from inline `MEGA_TOKENS`/`MEGA_ACCENT_TINTS` styles to
//   the shadcn-style `Badge`/`Button` primitives + Tailwind utilities
//   already shipped by UI-02 (GC-02).
// - The emoji picker's trigger label and emoji set are now required
//   caller-supplied props instead of a module-level default (this card's
//   AC requires zero hardcoded user-facing copy, GC-14 — upstream defaulted
//   to `['👍', '🎉', '🚀', '❤️']` and an undefined aria-label). They are
//   grouped into one `addAction` object (rather than a discriminated
//   union keyed off `onReactionAdd`) so the whole prop stays a single flat
//   interface that composites can spread through unchanged (a
//   discriminated union collapses when spread via JSX `{...props}`).
import { useState } from "react"

import { cn } from "../lib/cn"

export interface ReactionItem {
  emoji: string
  count: number
  reactedByMe: boolean
}

export interface ReactionsBarAddAction {
  /** Accessible name for the "add reaction" trigger (GC-14). */
  label: string
  /** Emoji choices shown once the add-reaction picker opens (caller-supplied; GC-14). */
  emojiOptions: readonly string[]
  onAdd(emoji: string): void
}

export interface ReactionsBarProps {
  /** Renders a dashed "+" trigger that opens an emoji picker when supplied. */
  addAction?: ReactionsBarAddAction
  className?: string
  onReactionToggle?(reaction: ReactionItem): void
  reactions: readonly ReactionItem[]
}

function ReactionPill({
  onToggle,
  reaction,
}: {
  onToggle?(reaction: ReactionItem): void
  reaction: ReactionItem
}) {
  const className = cn(
    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs",
    reaction.reactedByMe
      ? "border-primary/40 bg-primary/10 text-primary"
      : "border-input bg-muted text-muted-foreground"
  )

  if (!onToggle) {
    return (
      <span className={className} data-reaction-readonly="true">
        {reaction.emoji} {reaction.count}
      </span>
    )
  }

  return (
    <button
      aria-pressed={reaction.reactedByMe}
      className={cn(className, "cursor-pointer")}
      onClick={() => onToggle(reaction)}
      type="button"
    >
      {reaction.emoji} {reaction.count}
    </button>
  )
}

function AddReactionButton({
  emojiOptions,
  label,
  onAdd,
}: {
  emojiOptions: readonly string[]
  label: string
  onAdd(emoji: string): void
}) {
  const [open, setOpen] = useState(false)

  return (
    <span className="relative inline-flex" data-slot="reactions-bar-add">
      <button
        aria-expanded={open}
        aria-label={label}
        className="inline-flex h-6 items-center rounded-full border border-dashed border-input px-2 text-xs text-muted-foreground"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        +
      </button>
      {open && (
        <span
          className="absolute top-full left-0 z-10 mt-1 flex gap-1 rounded-md border bg-popover p-1 shadow-md"
          role="group"
        >
          {emojiOptions.map((emoji) => (
            <button
              className="rounded-sm px-1.5 py-0.5 text-sm hover:bg-accent"
              key={emoji}
              onClick={() => {
                onAdd(emoji)
                setOpen(false)
              }}
              type="button"
            >
              {emoji}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

/** Shared reaction-pill row consumed by `CommentThread` and `ChatMessage`. */
export function ReactionsBar({ addAction, className, onReactionToggle, reactions }: ReactionsBarProps) {
  if (reactions.length === 0 && !addAction) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} data-slot="reactions-bar">
      {reactions.map((reaction) => (
        <ReactionPill key={reaction.emoji} onToggle={onReactionToggle} reaction={reaction} />
      ))}
      {addAction && (
        <AddReactionButton emojiOptions={addAction.emojiOptions} label={addAction.label} onAdd={addAction.onAdd} />
      )}
    </div>
  )
}
