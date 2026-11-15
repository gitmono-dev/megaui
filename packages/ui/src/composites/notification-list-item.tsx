// megaui:libs/react-shared/components/mega/composites/dashboard.tsx@0ff3a9d (DashboardListRow, adapted)
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - `DashboardListRow`'s anchor/button/static discriminated-union shape
//   (a stable outer row + the interactive target rendered as a sibling of
//   any trailing action, so no interactive element ever nests inside
//   another) is kept, but specialized to the notification row this card's
//   description calls for instead of staying a generic composite — no
//   other REF-05 subpath in this card's write set needs the generic form.
// - Styling moves from inline `MEGA_TOKENS` styles to Tailwind utilities +
//   the shadcn-style `Avatar`/`Skeleton` primitives (GC-02).
// - `title`/`timestampLabel` are required caller-supplied `ReactNode`s
//   (this card's AC requires zero hardcoded copy, GC-14): unlike upstream,
//   this module never resolves a `Notification.title` or `NotificationKind`
//   itself, so it has no i18n dictionary coupling at all.
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react"

import { cn } from "../lib/cn"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"
import { Skeleton } from "../ui/skeleton"

export interface NotificationActor {
  avatarInitials: string
  avatarUrl?: string
  displayName: string
}

interface NotificationListItemBaseProps {
  actor?: NotificationActor
  className?: string
  icon?: ReactNode
  id: string
  /** Renders a skeleton placeholder instead of content. */
  loading?: boolean
  /** Unread notifications render a leading accent dot. */
  read?: boolean
  timestampLabel: ReactNode
  title: ReactNode
  trailing?: ReactNode
}

export type NotificationListItemProps =
  | (NotificationListItemBaseProps & {
      anchorProps?: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href">
      href: string
      onSelect?: never
    })
  | (NotificationListItemBaseProps & {
      anchorProps?: never
      buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick">
      href?: never
      onSelect(): void
    })

export function NotificationListItemSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 py-2", className)} data-slot="notification-list-item-skeleton">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <Skeleton className="h-4 flex-1" />
    </div>
  )
}

const targetClassName =
  "flex min-w-0 flex-1 items-center gap-3 py-2 text-left text-sm no-underline"

/** One notification row; `href` renders a link, `onSelect` renders a button. */
export function NotificationListItem(props: NotificationListItemProps) {
  const { actor, className, icon, id, loading = false, read = false, timestampLabel, title, trailing } = props

  if (loading) return <NotificationListItemSkeleton className={className} />

  const content = (
    <>
      {icon ?? (
        actor && (
          <Avatar className="size-8 shrink-0">
            <AvatarImage alt="" src={actor.avatarUrl} />
            <AvatarFallback>{actor.avatarInitials}</AvatarFallback>
          </Avatar>
        )
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{timestampLabel}</span>
      </span>
    </>
  )

  const target =
    props.href !== undefined ? (
      <a {...props.anchorProps} className={targetClassName} href={props.href}>
        {content}
      </a>
    ) : (
      <button {...props.buttonProps} className={targetClassName} onClick={props.onSelect} type="button">
        {content}
      </button>
    )

  return (
    <div
      className={cn("flex items-center gap-2 border-b px-1 last:border-b-0", className)}
      data-notification-id={id}
      data-read={read}
      data-slot="notification-list-item"
    >
      {!read && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />}
      {target}
      {trailing !== undefined && <div className="shrink-0">{trailing}</div>}
    </div>
  )
}
