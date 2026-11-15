// megaui:libs/react-shared/components/mega/controls/tabs.tsx@0ff3a9d (SegmentedControl, adapted)
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream's `SegmentedControl` renders raw `<button>`s styled against
//   `MEGA_TOKENS` inline. This port composes the shadcn-style `Button`
//   primitive UI-02 already ships (GC-02 single source of truth) instead
//   of a second button implementation.
// - `UnderlineTabs` (roving-tabindex `role="tablist"`) is not ported: it
//   duplicates the `Tabs`/`TabsList`/`TabsTrigger` Radix primitive UI-10
//   already ships, which this card's dependency set (UI-10) makes
//   available — a second tab implementation would violate GC-02.
import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { Button } from "../ui/button"

export interface ViewToggleOption<T extends string> {
  disabled?: boolean
  label: ReactNode
  value: T
}

export interface ViewToggleProps<T extends string> {
  ariaLabel: string
  className?: string
  onValueChange(value: T): void
  options: readonly ViewToggleOption<T>[]
  value: T
}

/** A compact segmented button group for switching between list/board/etc. views. */
export function ViewToggle<T extends string>({
  ariaLabel,
  className,
  onValueChange,
  options,
  value,
}: ViewToggleProps<T>) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn("inline-flex rounded-md border p-0.5", className)}
      data-slot="view-toggle"
      role="group"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Button
            aria-pressed={selected}
            className="h-7 px-2.5"
            disabled={option.disabled}
            key={option.value}
            onClick={() => onValueChange(option.value)}
            size="sm"
            type="button"
            variant={selected ? "secondary" : "ghost"}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
