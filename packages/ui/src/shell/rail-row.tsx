// megaui:libs/react-shared/components/mega/shell/rail-row.tsx@0ff3a9d
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react"

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import { SideNavItem } from "./atoms"
import { formatRailCount } from "./nav-config"

export interface WorkspaceRailLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  children: ReactNode
  "data-mega-shell"?: string
  href: string
}

export type WorkspaceRailLinkRenderer = (props: WorkspaceRailLinkProps) => ReactElement

export interface RailRowProps {
  active?: boolean
  count?: number
  countAriaLabel?: string
  href: string
  icon?: ReactNode
  label: ReactNode
  mention?: boolean
  renderLink: WorkspaceRailLinkRenderer
}

export function RailRow({ active = false, count = 0, countAriaLabel, href, icon, label, mention = false, renderLink }: RailRowProps) {
  const formattedCount = formatRailCount(count)
  const badge = formattedCount ? (
    <span
      aria-label={countAriaLabel}
      data-mega-shell="rail-count"
      data-tone={mention ? "mention" : "default"}
      style={{
        alignItems: "center",
        background: mention ? MEGA_TOKENS.danger : MEGA_TOKENS.border,
        border: "none",
        borderRadius: 8,
        color: mention ? MEGA_TOKENS.accentForeground : MEGA_TOKENS.muted,
        display: "inline-flex",
        flexShrink: 0,
        fontSize: "calc(var(--mega-density-font-size) - 3px)",
        fontWeight: 700,
        height: 16,
        justifyContent: "center",
        minWidth: 16,
        padding: `0 ${MEGA_SPACING_TOKENS[5]}`,
      }}
    >
      {formattedCount}
    </span>
  ) : undefined

  const link = renderLink({
    href,
    children: (
      <span
        data-mega-shell="rail-row-label"
        style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </span>
    ),
  })

  return (
    <div data-mega-shell="rail-row-wrap" style={{ padding: `0 ${MEGA_SPACING_TOKENS[6]}` }}>
      <SideNavItem
        active={active}
        asChild
        count={badge}
        data-mention={mention ? "true" : undefined}
        icon={icon ? <span aria-hidden="true" style={{ alignItems: "center", color: active ? MEGA_TOKENS.activeFg : MEGA_TOKENS.muted, display: "inline-flex", flexShrink: 0 }}>{icon}</span> : undefined}
        label={link}
      />
    </div>
  )
}
