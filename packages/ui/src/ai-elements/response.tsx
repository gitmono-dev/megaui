// megaui:libs/react-shared/components/ai-elements/response.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card): none — ported
// verbatim. `streamdown` is already a `packages/ui` dependency (UI-01
// baseline `package.json`).
import { memo, type ComponentProps } from "react"
import { Streamdown } from "streamdown"

import { cn } from "../lib/cn"

export type ResponseProps = ComponentProps<typeof Streamdown>

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)} {...props} />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
)

Response.displayName = "Response"
