// megaui:libs/react-shared/components/mega/composites/cl-summary-card.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream renders raw inline styles keyed off `MEGA_TOKENS`/
//   `MEGA_SPACING_TOKENS` and its own `atoms` (`ShellAvatar`, `CLStatePill`,
//   `DiffStatText`, `PackageChip`) + a `MegaIcon` glyph set. None of those
//   modules are assigned to any card's write set (no `mega/atoms` or
//   `mega/icons` REF-05 subpath exists in the plan), so this port instead
//   composes the shadcn-style primitives UI-02/UI-10 already shipped
//   (`Card`, `Badge`, `Avatar`, `Skeleton`) plus `lucide-react` icons —
//   matching every other `packages/ui` surface (GC-02 single source of
//   truth; no parallel styling system).
// - Upstream resolves its own route via `entityRefHref` and formats the
//   diff/file-count strings via `formatDiffStat` (`@libs/mega/refs`).
//   Neither helper is in this card's write set, so the caller now supplies
//   an already-resolved `href` plus already-formatted `diffLabel` /
//   `fileCountLabel` — consistent with this card's AC that no user-facing
//   copy is hardcoded (GC-14): every label is caller-supplied, including
//   `stateLabel`.
// - `cl`'s shape narrows a subset of `@megaui/core`'s `CL` type (this
//   card is the first `packages/ui` surface to depend on `@megaui/core`;
//   see `packages/ui/README.md`) instead of upstream's own `CL` type.
import type { CL } from "@megaui/core"
import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar"
import { Badge } from "../ui/badge"
import { Skeleton } from "../ui/skeleton"

export type CLSummary = Pick<CL, "additions" | "author" | "deletions" | "number" | "state" | "title"> &
  Partial<Pick<CL, "description" | "packageId">>

export interface CLSummaryCardProps {
  actions?: ReactNode
  cl: CLSummary
  className?: string
  /** Pre-formatted "+12 -4" style diff stat (caller formats; GC-14). */
  diffLabel?: ReactNode
  /** Pre-formatted file-count label, e.g. "4 files changed" (caller formats; GC-14). */
  fileCountLabel?: ReactNode
  /** Resolved destination for the CL number/title links (caller owns routing). */
  href: string
  /** Renders a skeleton placeholder instead of `cl` content. */
  loading?: boolean
  onSelect?(): void
  /** Already-localized package byline, e.g. "apps/web" (caller formats). */
  packageLabel?: ReactNode
  /** Already-localized CL state label (e.g. "Ready", "Merged"). */
  stateLabel: ReactNode
  variant?: "row" | "unfurl" | "detail"
}

const clStateBadgeClassName: Record<CL["state"], string> = {
  ready: "border-transparent bg-primary text-primary-foreground",
  wip: "border-transparent bg-secondary text-secondary-foreground",
  queued: "text-foreground",
  merged: "border-transparent bg-primary text-primary-foreground",
  closed: "border-transparent bg-destructive text-white",
  conflicts: "border-transparent bg-destructive text-white",
}

function CLStateBadge({ state, stateLabel }: { state: CL["state"]; stateLabel: ReactNode }) {
  return (
    <Badge className={cn(clStateBadgeClassName[state])} data-cl-state={state}>
      {stateLabel}
    </Badge>
  )
}

export function CLSummaryCardSkeleton({
  className,
  variant = "unfurl",
}: {
  className?: string
  variant?: CLSummaryCardProps["variant"]
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border p-4",
        variant === "row" && "rounded-none border-0 border-b p-0 py-2",
        className
      )}
      data-slot="cl-summary-card-skeleton"
    >
      <Skeleton className="h-5 w-10 shrink-0" />
      <Skeleton className="h-5 flex-1" />
      <Skeleton className="h-5 w-16 shrink-0" />
    </div>
  )
}

/** One CL surface shared by Home rows, Inbox summaries, and chat unfurls. */
export function CLSummaryCard({
  actions,
  cl,
  className,
  diffLabel,
  fileCountLabel,
  href,
  loading = false,
  onSelect,
  packageLabel,
  stateLabel,
  variant = "unfurl",
}: CLSummaryCardProps) {
  if (loading) return <CLSummaryCardSkeleton className={className} variant={variant} />

  const handleClick = onSelect ? () => onSelect() : undefined

  if (variant === "row") {
    return (
      <article
        className={cn("flex min-h-10 items-center gap-2", className)}
        data-cl-variant={variant}
        data-slot="cl-summary-card"
      >
        <span className="shrink-0 font-mono text-xs font-bold text-primary">!{cl.number}</span>
        <a
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          href={href}
          onClick={handleClick}
        >
          {cl.title}
        </a>
        <CLStateBadge state={cl.state} stateLabel={stateLabel} />
        <Avatar className="size-5">
          <AvatarImage alt="" src={cl.author.avatarUrl} />
          <AvatarFallback className="text-[10px]">{cl.author.avatarInitials}</AvatarFallback>
        </Avatar>
      </article>
    )
  }

  return (
    <article
      className={cn(
        "rounded-lg border border-l-4 border-l-primary bg-card p-4",
        variant === "unfurl" && "max-w-md",
        className
      )}
      data-cl-variant={variant}
      data-slot="cl-summary-card"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold text-primary">!{cl.number}</span>
        <CLStateBadge state={cl.state} stateLabel={stateLabel} />
        <span className="flex-1" />
        {diffLabel !== undefined && (
          <span className="font-mono text-xs font-semibold text-muted-foreground">{diffLabel}</span>
        )}
        {fileCountLabel !== undefined && cl.description !== undefined && (
          <span className="text-xs text-muted-foreground">{fileCountLabel}</span>
        )}
      </header>

      <a
        className={cn(
          "mt-1.5 block text-sm font-semibold hover:underline",
          variant === "detail" && "text-base"
        )}
        href={href}
        onClick={handleClick}
      >
        {cl.title}
      </a>

      {cl.description && <p className="mt-1.5 text-sm text-muted-foreground">{cl.description}</p>}

      {(variant === "detail" || cl.packageId || actions) && (
        <footer className="mt-2 flex flex-wrap items-center gap-2">
          {cl.packageId && packageLabel !== undefined && (
            <span className="font-mono text-xs text-muted-foreground">{packageLabel}</span>
          )}
          {variant === "detail" && (
            <span className="text-xs text-muted-foreground">{cl.author.displayName}</span>
          )}
          <span className="flex-1" />
          {actions}
        </footer>
      )}
    </article>
  )
}
