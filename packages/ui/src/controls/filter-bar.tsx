// megaui:libs/react-shared/components/mega/controls/filter-query-bar.tsx@0ff3a9d
// megaui:libs/react-shared/components/mega/controls/dropdown.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream's `FilterQueryBar` parses a DSL query string live (`@libs/mega/filter`'s
//   `parseQuery`) and paints per-token syntax highlighting via a
//   caret-tracking overlay `<span>`. That parser is engine-owned business
//   logic (`packages/engine`), which `packages/ui` may not depend on
//   (ADR-ARCH-01 `ui-restricted-deps`). This control is therefore a plain
//   controlled search input — the caller (a `packages/engine`-aware page)
//   owns query parsing and passes already-resolved `filters` instead.
// - `FilterDropdown`'s custom `role="listbox"` + manual arrow-key handling
//   is replaced by the `DropdownMenu`/`DropdownMenuItem` Radix primitive
//   UI-10 already ships (GC-02 — one popover-menu implementation, not two)
//   and its `MegaIcon` check glyph by `lucide-react`'s `CheckIcon` (already
//   used by every other `packages/ui` dropdown, e.g. `select.tsx`).
// - Styling moves from inline `MEGA_TOKENS` styles to the shadcn-style
//   `Input`/`Button`/`DropdownMenu` primitives + Tailwind utilities.
import { CheckIcon, SearchIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "../lib/cn"
import { Button } from "../ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { Input } from "../ui/input"

export interface FilterBarFilterOption {
  label: ReactNode
  selected: boolean
  value: string
}

export interface FilterBarFilter {
  /** Accessible name for the trigger when `label` is purely decorative. */
  ariaLabel?: string
  key: string
  label: ReactNode
  onSelect(value: string): void
  options: readonly FilterBarFilterOption[]
}

export interface FilterBarProps {
  /** Accessible name for the search input. */
  ariaLabel: string
  className?: string
  filters?: readonly FilterBarFilter[]
  onValueChange(value: string): void
  placeholder?: string
  value: string
}

function FilterBarDropdown({ filter }: { filter: FilterBarFilter }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={filter.ariaLabel} size="sm" type="button" variant="outline">
          {filter.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {filter.options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => filter.onSelect(option.value)}>
            <CheckIcon className={cn("size-4", !option.selected && "invisible")} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Search input + optional single-select filter dropdowns (issues/CL list toolbars). */
export function FilterBar({ ariaLabel, className, filters = [], onValueChange, placeholder, value }: FilterBarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} data-slot="filter-bar">
      <div className="relative min-w-48 flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={ariaLabel}
          className="pl-8"
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      </div>
      {filters.map((filter) => <FilterBarDropdown filter={filter} key={filter.key} />)}
    </div>
  )
}
