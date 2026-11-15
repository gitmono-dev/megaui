/**
 * New for UI-08. Upstream tree node shape (libs/mega/types.ts TreeNode)
 * lives on the app-domain layer (@megaui/core), which @megaui/ui does
 * not depend on (component write set stays self-contained, GC-06). This is
 * a structurally-compatible, presentation-only subset: any consumer's
 * domain tree node shaped like this works without adapting fields.
 */
export type FileTreeNodeKind = "file" | "directory"

export interface FileTreeNode {
  name: string
  path: string
  kind: FileTreeNodeKind
  /** Default-open hint consumed by `defaultExpandedPaths` when no explicit override is passed. */
  expanded?: boolean
  children?: readonly FileTreeNode[]
}
