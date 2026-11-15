// megaui:libs/react-shared/components/ai-elements/message.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream types `from` as the `ai` SDK's `UIMessage["role"]`; that
//   package is not a `packages/ui` dependency, so `from` is a local
//   `"assistant" | "system" | "user"` union covering this card's
//   description ("agent 消息元素") without the extra dependency.
// - `MessageAvatar`'s fallback defaulted to a hardcoded `"ME"` string;
//   this card's AC requires zero hardcoded user-facing copy (GC-14), so
//   the fallback derives only from the caller-supplied `name` (empty
//   `AvatarFallback` renders nothing, matching the underlying Radix
//   primitive's own no-fallback behavior).
// - `MessageCitations` and `MessageUsage` are megaui-only additions: this
//   card's description explicitly calls for agent "citations/usage"
//   message elements, which upstream's 5-file `ai-elements/**` slice never
//   grew (upstream's agent surface renders citations ad hoc, page-level).
//   `MessageCitations` consumes `@megaui/core`'s `Citation` type.
import type { Citation } from "@megaui/core"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps, HTMLAttributes, ReactNode } from "react"

import { cn } from "../lib/cn"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"

export type MessageRole = "assistant" | "system" | "user"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole
}

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full items-end gap-2 py-4",
        from === "user" ? "flex-row-reverse justify-start" : "justify-start",
        className
      )}
      data-message-role={from}
      {...props}
    />
  )
}

const messageContentVariants = cva("flex flex-col gap-2 overflow-hidden rounded-lg text-sm", {
  variants: {
    variant: {
      contained: [
        "max-w-[80%] px-4 py-3",
        "group-data-[message-role=user]:bg-primary group-data-[message-role=user]:text-primary-foreground",
        "group-data-[message-role=assistant]:bg-secondary group-data-[message-role=assistant]:text-foreground",
      ],
      flat: ["text-foreground"],
    },
  },
  defaultVariants: {
    variant: "contained",
  },
})

export type MessageContentProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof messageContentVariants>

export function MessageContent({ className, variant, ...props }: MessageContentProps) {
  return <div className={cn(messageContentVariants({ variant }), className)} {...props} />
}

export type MessageAvatarProps = ComponentProps<typeof Avatar> & {
  name?: string
  src?: string
}

export function MessageAvatar({ className, name, src, ...props }: MessageAvatarProps) {
  return (
    <Avatar className={cn("size-8 ring-1 ring-border", className)} {...props}>
      <AvatarImage alt="" src={src} />
      <AvatarFallback>{name?.slice(0, 2)}</AvatarFallback>
    </Avatar>
  )
}

export interface MessageCitationsProps {
  citations: readonly Citation[]
  className?: string
  /** Already-localized section label, e.g. "Sources" (caller-supplied; GC-14). */
  label: ReactNode
}

export function MessageCitations({ citations, className, label }: MessageCitationsProps) {
  if (citations.length === 0) return null

  return (
    <div className={cn("mt-2 flex flex-wrap items-center gap-1.5 text-xs", className)} data-slot="message-citations">
      <span className="text-muted-foreground">{label}</span>
      {citations.map((citation) => (
        <a
          className="rounded-full border px-2 py-0.5 text-muted-foreground hover:text-foreground hover:underline"
          data-citation-kind={citation.kind}
          href={citation.url}
          key={citation.id}
        >
          {citation.label}
        </a>
      ))}
    </div>
  )
}

export interface MessageUsageItem {
  label: ReactNode
  value: ReactNode
}

export interface MessageUsageProps {
  className?: string
  items: readonly MessageUsageItem[]
}

/** Renders already-formatted token/latency/cost usage stats (caller resolves every value; GC-14). */
export function MessageUsage({ className, items }: MessageUsageProps) {
  if (items.length === 0) return null

  return (
    <dl className={cn("mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground", className)} data-slot="message-usage">
      {items.map((item, index) => (
        <div className="flex items-center gap-1" key={index}>
          <dt>{item.label}</dt>
          <dd className="font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
