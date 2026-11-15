// megaui:libs/react-shared/components/mega/composites/comment-card.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream's comment body is a `MegaContentReader` rendering Lexical
//   editor-state JSON (`normalizeCommentBodyJson`), which depends on
//   `libs/react-shared/components/mega/content/reader.tsx` — that surface
//   is UI-07's write set, not this card's. `body`/reply `body` are
//   therefore plain `ReactNode` here; the caller renders (or defers to
//   UI-07's reader for) rich content.
// - The reaction-pill/add-reaction UI is extracted into the standalone
//   `ReactionsBar` composite (see that module's header) instead of being
//   inlined twice.
// - `EntityRefLink`'s `references` footer (inline `@user`/`#issue`/`!CL`
//   token routing) is out of this card's write set (no `@libs/mega/refs`
//   equivalent is ported here) — callers that need it render their own
//   reference chips via the `after` slot.
// - Styling moves from inline `MEGA_TOKENS` styles to the shadcn-style
//   `Avatar`/`Badge`/`Skeleton` primitives + Tailwind utilities (GC-02).
import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"
import { Badge } from "../ui/badge"
import { Skeleton } from "../ui/skeleton"
import { ReactionsBar, type ReactionsBarProps } from "./reactions-bar"

export interface CommentAuthor {
  avatarInitials: string
  avatarUrl?: string
  displayName: string
  id: string
}

export interface CommentThreadReply {
  author: CommentAuthor
  body: ReactNode
  id: string
  timestampLabel: ReactNode
}

export type CommentThreadReactionsProps = ReactionsBarProps

export interface CommentThreadProps {
  /** Trailing header action (e.g. an edit/close button). */
  action?: ReactNode
  /** Renders after the body, e.g. reference chips resolved by the caller. */
  after?: ReactNode
  author: CommentAuthor
  body: ReactNode
  className?: string
  id: string
  /** Renders a skeleton placeholder instead of content. */
  loading?: boolean
  reactions?: CommentThreadReactionsProps
  replies?: readonly CommentThreadReply[]
  /** Already-localized role chip, e.g. "Owner", "Bot" (caller-supplied; GC-14). */
  roleLabel?: ReactNode
  timestampLabel: ReactNode
  /** `assistant` renders the accent avatar/surface treatment for AI-authored comments. */
  tone?: "assistant" | "default"
}

function CommentAvatar({ author, tone }: { author: CommentAuthor; tone: "assistant" | "default" }) {
  if (tone === "assistant") {
    return (
      <span
        aria-label={author.displayName}
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
        role="img"
      >
        {author.avatarInitials}
      </span>
    )
  }

  return (
    <Avatar className="size-8">
      <AvatarImage alt="" src={author.avatarUrl} />
      <AvatarFallback>{author.avatarInitials}</AvatarFallback>
    </Avatar>
  )
}

function CommentReply({ reply }: { reply: CommentThreadReply }) {
  return (
    <div className="flex gap-2 pt-2" data-slot="comment-thread-reply">
      <Avatar className="size-6">
        <AvatarImage alt="" src={reply.author.avatarUrl} />
        <AvatarFallback className="text-[10px]">{reply.author.avatarInitials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <strong className="text-sm">{reply.author.displayName}</strong>
          <span className="text-xs text-muted-foreground">{reply.timestampLabel}</span>
        </div>
        <div className="mt-0.5 text-sm">{reply.body}</div>
      </div>
    </div>
  )
}

export function CommentThreadSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex gap-2", className)} data-slot="comment-thread-skeleton">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    </div>
  )
}

/** Shared issue/doc/CL/chat comment surface with a single-level reply slot. */
export function CommentThread({
  action,
  after,
  author,
  body,
  className,
  id,
  loading = false,
  reactions,
  replies = [],
  roleLabel,
  timestampLabel,
  tone = "default",
}: CommentThreadProps) {
  if (loading) return <CommentThreadSkeleton className={className} />

  return (
    <article className={cn("flex gap-2", className)} data-slot="comment-thread" id={`comment-${id}`}>
      <CommentAvatar author={author} tone={tone} />

      <div
        className={cn(
          "min-w-0 flex-1 overflow-hidden rounded-lg border bg-card",
          tone === "assistant" && "border-primary/30 bg-primary/5"
        )}
      >
        <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <strong className="text-sm">{author.displayName}</strong>
          {roleLabel !== undefined && <Badge variant="secondary">{roleLabel}</Badge>}
          <span className="text-xs text-muted-foreground">{timestampLabel}</span>
          <span className="flex-1" />
          {action}
        </header>

        <div className="px-3 py-3 text-sm leading-relaxed">{body}</div>

        {after !== undefined && <div className="px-3 pb-3">{after}</div>}

        {(reactions !== undefined || replies.length > 0) && (
          <footer className="border-t px-3 py-3">
            {reactions !== undefined && <ReactionsBar {...reactions} />}
            {replies.map((reply) => <CommentReply key={reply.id} reply={reply} />)}
          </footer>
        )}
      </div>
    </article>
  )
}
