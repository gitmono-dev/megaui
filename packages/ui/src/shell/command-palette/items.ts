/**
 * megaui:libs/react-shared/components/mega/command-palette/items.ts@0ff3a9d
 *
 * Diff vs upstream (GC-03): dropped `paletteIssueHref`/`paletteClHref`/
 * `paletteBodyHitHref` — those routed through `entityRefHref` and
 * `WorkspaceBodyHit` (`@libs/mega/services`), domain types not reachable
 * from `packages/ui`'s allowed dependency surface without a
 * `package.json` change (out of scope for this card; search-result
 * wiring is `WA-03`/`WA-07` territory). `paletteDocHref`/`paletteFileHref`
 * only need `workspaceHref`, so they're kept.
 */
import { MEGA_NAV_ITEMS, workspaceHref } from "../nav-config"
import type { ShellIconName } from "../icons"

export const MEGA_PALETTE_ACTION_IDS = ["newCl", "reportIssue", "askAgent", "writeDoc"] as const

export type MegaPaletteActionId = (typeof MEGA_PALETTE_ACTION_IDS)[number]

export interface MegaPaletteActionConfig {
  icon: ShellIconName
  id: MegaPaletteActionId
  path: string
}

/** The four designed quick actions; each routes to its target surface (Out of scope: full form flows). */
export const MEGA_PALETTE_ACTIONS: readonly MegaPaletteActionConfig[] = [
  { id: "newCl", icon: "plus", path: "cls" },
  { id: "reportIssue", icon: "bug", path: "issues" },
  { id: "askAgent", icon: "sparkle", path: "agent" },
  { id: "writeDoc", icon: "book", path: "docs" },
]

export { MEGA_NAV_ITEMS, workspaceHref }

export function paletteDocHref(workspaceBase: string, docId: string): string {
  return `${workspaceHref(workspaceBase, "docs")}/${encodeURIComponent(docId)}`
}

export function paletteFileHref(workspaceBase: string, path: string): string {
  const encoded = path.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/")
  return `${workspaceHref(workspaceBase, "code")}/${encoded}`
}
