// megaui-only: shared placeholder for empty lists and failed-to-load panels.
//
// One component covers both situations through `tone`; `title` has no default
// so every call site supplies its own translated copy (GC-14). The `error`
// tone is announced to assistive tech via `role="alert"`.
import type { ReactNode } from "react"

import { cn } from "../lib/cn"

export interface EmptyStateProps {
  action?: ReactNode
  className?: string
  description?: ReactNode
  icon?: ReactNode
  title: ReactNode
  tone?: "empty" | "error"
}

const TONE_STYLES = {
  empty: { icon: "text-muted-foreground", title: "" },
  error: { icon: "text-destructive", title: "text-destructive" },
} as const satisfies Record<NonNullable<EmptyStateProps["tone"]>, { icon: string; title: string }>

/** Shared empty/error placeholder for lists and panels (GC-02). */
export function EmptyState({ action, className, description, icon, title, tone = "empty" }: EmptyStateProps) {
  const styles = TONE_STYLES[tone]

  return (
    <div
      data-slot="empty-state"
      data-tone={tone}
      role={tone === "error" ? "alert" : undefined}
      className={cn("size-full flex flex-col items-center justify-center gap-3 p-8 text-center", className)}
    >
      {icon && <div className={styles.icon}>{icon}</div>}
      <div className="space-y-1">
        <h3 className={cn("text-sm font-medium", styles.title)}>{title}</h3>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}
