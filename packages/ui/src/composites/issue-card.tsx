// N/A（megaui-only）
//
// No shared `libs/react-shared/components/mega/composites/**` surface
// exists upstream for issues — upstream's issue rows live page-locally under
// `apps/next-app/app/[lang]/workspace/issues/components/issue-row.tsx`,
// outside this card's `Reference source` (`mega/{composites,controls}` +
// `ai-elements`) and outside this card's `Out of scope` (page-level layout
// belongs to the WA-* page cards). This composite mirrors
// `CLSummaryCard`'s API (GC-02 — one shared shape instead of the issues
// page and any future cross-surface issue unfurl each rolling their own).
import type { Issue, Label } from "@megaui/core"
import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"
import { Badge } from "../ui/badge"
import { Skeleton } from "../ui/skeleton"

export type IssueSummary = Pick<Issue, "author" | "number" | "state" | "title"> &
  Partial<Pick<Issue, "labels" | "priority">>

export interface IssueCardProps {
  actions?: ReactNode
  className?: string
  /** Already-localized comment-count label, e.g. "3 comments" (caller formats; GC-14). */
  commentCountLabel?: ReactNode
  /** Resolved destination for the issue number/title links (caller owns routing). */
  href: string
  issue: IssueSummary
  /** Renders a skeleton placeholder instead of `issue` content. */
  loading?: boolean
  onSelect?(): void
  /** Already-localized priority label (e.g. "P0"); omit to hide the chip. */
  priorityLabel?: ReactNode
  /** Already-localized issue state label (e.g. "Open", "Closed"). */
  stateLabel: ReactNode
  variant?: "row" | "detail"
}

const issueStateBadgeClassName: Record<Issue["state"], string> = {
  open: "border-transparent bg-primary text-primary-foreground",
  closed: "text-foreground",
}

function IssueLabelChip({ label }: { label: Label }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
      data-slot="issue-label-chip"
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </span>
  )
}

export function IssueCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex items-center gap-3 rounded-lg border p-4", className)}
      data-slot="issue-card-skeleton"
    >
      <Skeleton className="h-5 w-10 shrink-0" />
      <Skeleton className="h-5 flex-1" />
      <Skeleton className="h-5 w-16 shrink-0" />
    </div>
  )
}

/** Issue summary card; API mirrors `CLSummaryCard` for GC-02 consistency. */
export function IssueCard({
  actions,
  className,
  commentCountLabel,
  href,
  issue,
  loading = false,
  onSelect,
  priorityLabel,
  stateLabel,
  variant = "row",
}: IssueCardProps) {
  if (loading) return <IssueCardSkeleton className={className} />

  const handleClick = onSelect ? () => onSelect() : undefined

  if (variant === "row") {
    return (
      <article
        className={cn("flex min-h-10 items-center gap-2", className)}
        data-issue-variant={variant}
        data-slot="issue-card"
      >
        <span className="shrink-0 font-mono text-xs font-bold text-muted-foreground">#{issue.number}</span>
        <a
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          href={href}
          onClick={handleClick}
        >
          {issue.title}
        </a>
        {issue.labels?.map((label) => <IssueLabelChip key={label.id} label={label} />)}
        {priorityLabel !== undefined && <Badge variant="outline">{priorityLabel}</Badge>}
        <Badge className={cn(issueStateBadgeClassName[issue.state])} data-issue-state={issue.state}>
          {stateLabel}
        </Badge>
        <Avatar className="size-5">
          <AvatarImage alt="" src={issue.author.avatarUrl} />
          <AvatarFallback className="text-[10px]">{issue.author.avatarInitials}</AvatarFallback>
        </Avatar>
      </article>
    )
  }

  return (
    <article
      className={cn("rounded-lg border bg-card p-4", className)}
      data-issue-variant={variant}
      data-slot="issue-card"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold text-muted-foreground">#{issue.number}</span>
        <Badge className={cn(issueStateBadgeClassName[issue.state])} data-issue-state={issue.state}>
          {stateLabel}
        </Badge>
        {priorityLabel !== undefined && <Badge variant="outline">{priorityLabel}</Badge>}
        <span className="flex-1" />
        {commentCountLabel !== undefined && (
          <span className="text-xs text-muted-foreground">{commentCountLabel}</span>
        )}
      </header>

      <a className="mt-1.5 block text-base font-semibold hover:underline" href={href} onClick={handleClick}>
        {issue.title}
      </a>

      {issue.labels && issue.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {issue.labels.map((label) => <IssueLabelChip key={label.id} label={label} />)}
        </div>
      )}

      <footer className="mt-3 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{issue.author.displayName}</span>
        <span className="flex-1" />
        {actions}
      </footer>
    </article>
  )
}
