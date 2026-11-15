// megaui:libs/react-shared/components/mega/shell/workspace-shell.tsx@0ff3a9d
import type { ReactNode } from "react"

import { MEGA_TOKENS } from "../tokens/mega-tokens"

export interface WorkspaceShellProps {
  children: ReactNode
  rail: ReactNode
}

export function WorkspaceShell({ children, rail }: WorkspaceShellProps) {
  return (
    <div
      data-mega-shell="workspace"
      style={{ background: MEGA_TOKENS.subtle, color: MEGA_TOKENS.text, display: "flex", height: "100dvh", minHeight: 0, overflow: "hidden", width: "100%" }}
    >
      {rail}
      <div data-mega-shell="workspace-content" style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0, overflow: "auto" }}>
        {children}
      </div>
    </div>
  )
}
