// megaui:libs/react-shared/components/ai-elements/loader.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream inlines a bespoke 16x16 spinner SVG. This port uses
//   `lucide-react`'s `Loader2Icon` + `animate-spin` instead — every other
//   loading affordance in `packages/ui` already does this (e.g.
//   `form-error.tsx`'s resend button, `prompt-input`-style submit icons),
//   so this keeps one spinner glyph across the package (GC-02).
import { Loader2Icon } from "lucide-react"
import type { HTMLAttributes } from "react"

import { cn } from "../lib/cn"

export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  size?: number
}

export function Loader({ className, size = 16, ...props }: LoaderProps) {
  return (
    <div className={cn("inline-flex items-center justify-center", className)} data-slot="loader" {...props}>
      <Loader2Icon className="animate-spin" size={size} />
    </div>
  )
}
