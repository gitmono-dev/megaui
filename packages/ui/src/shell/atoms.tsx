/**
 * megaui:libs/react-shared/components/mega/atoms/avatar.tsx@0ff3a9d
 * megaui:libs/react-shared/components/mega/atoms/badges.tsx@0ff3a9d
 * megaui:libs/react-shared/components/mega/atoms/section-label.tsx@0ff3a9d
 * megaui:libs/react-shared/components/mega/controls/navigation.tsx@0ff3a9d
 *
 * Small presentational primitives the rail/palette compose. Kept local to
 * `packages/ui/src/shell/**` (rather than `packages/ui/src/ui/**`) because
 * UI-05's write set is scoped to this directory (GC-03: diff vs upstream
 * is file location only, markup/data-attributes/tokens are unchanged so
 * `../styles/mega.css` selectors keep matching).
 */
import { Slot, Slottable } from "@radix-ui/react-slot"
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react"

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import type { RailPresenceStatus } from "./rail-channels"

export type ShellAvatarTone = "accent" | "success" | "warning" | "danger" | "merged" | "muted"

const avatarToneColors: Record<ShellAvatarTone, string> = {
  accent: MEGA_TOKENS.accent,
  success: MEGA_TOKENS.success,
  warning: MEGA_TOKENS.warning,
  danger: MEGA_TOKENS.danger,
  merged: MEGA_TOKENS.merged,
  muted: MEGA_TOKENS.muted,
}

const avatarStatusColors: Record<RailPresenceStatus, string> = {
  online: MEGA_TOKENS.success,
  away: MEGA_TOKENS.warning,
  offline: MEGA_TOKENS.muted,
  busy: MEGA_TOKENS.danger,
}

export interface ShellAvatarUser {
  avatarInitials?: string
  avatarUrl?: string | null
}

export interface ShellAvatarProps {
  image?: string | null
  initials?: string
  user?: ShellAvatarUser
  tone?: ShellAvatarTone
  size?: number
}

/** A token-coloured, square workspace avatar for user initials or profile images. */
export function ShellAvatar({ image, initials, user, tone = "accent", size = 18 }: ShellAvatarProps) {
  const label = user?.avatarInitials ?? initials ?? ""
  const imageSrc = (image ?? user?.avatarUrl)?.trim()
  const frameStyle: CSSProperties = {
    borderRadius: MEGA_RADIUS_TOKENS.md,
    display: "inline-flex",
    flexShrink: 0,
    height: size,
    overflow: "hidden",
    width: size,
  }

  if (imageSrc) {
    return (
      <img
        alt=""
        aria-label={label}
        data-mega-atom="shell-avatar"
        src={imageSrc}
        style={{ ...frameStyle, objectFit: "cover" }}
      />
    )
  }

  const style: CSSProperties = {
    ...frameStyle,
    alignItems: "center",
    background: avatarToneColors[tone],
    color: MEGA_TOKENS.accentForeground,
    fontSize: size * 0.46,
    fontWeight: 600,
    justifyContent: "center",
    letterSpacing: "0.2px",
  }

  return (
    <span aria-label={label} data-mega-atom="shell-avatar" style={style}>
      {label}
    </span>
  )
}

export interface StatusDotProps {
  ariaLabel?: string
  status: RailPresenceStatus
  size?: number
}

/** A compact presence indicator that keeps all status colours token-derived. */
export function StatusDot({ ariaLabel, status, size = 8 }: StatusDotProps) {
  return (
    <span
      aria-label={ariaLabel ?? status}
      data-mega-atom="status-dot"
      style={{ background: avatarStatusColors[status], borderRadius: "50%", display: "inline-block", height: size, width: size }}
    />
  )
}

export interface KbdChipProps {
  children: ReactNode
}

export function KbdChip({ children }: KbdChipProps) {
  return (
    <kbd
      data-mega-atom="kbd-chip"
      style={{
        background: MEGA_TOKENS.subtle,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        color: MEGA_TOKENS.muted,
        fontFamily: MEGA_TOKENS.fontMono,
        fontSize: "calc(var(--mega-density-font-size) - 2.5px)",
        lineHeight: "18px",
        padding: `0 ${MEGA_SPACING_TOKENS[5]}`,
      }}
    >
      {children}
    </kbd>
  )
}

export interface SectionLabelProps {
  action?: ReactNode
  children: ReactNode
}

export function SectionLabel({ action, children }: SectionLabelProps) {
  return (
    <div
      data-mega-atom="section-label"
      style={{
        alignItems: "center",
        color: MEGA_TOKENS.muted,
        display: "flex",
        fontSize: "calc(var(--mega-density-font-size) - 2px)",
        fontWeight: 700,
        justifyContent: "space-between",
        letterSpacing: "0.5px",
        lineHeight: "var(--mega-density-row-height)",
        textTransform: "uppercase",
      }}
    >
      <span>{children}</span>
      {action}
    </div>
  )
}

interface SideNavItemBaseProps {
  active?: boolean
  count?: ReactNode
  "data-mention"?: string
  disabled?: boolean
  icon?: ReactNode
  onSelect?(): void
  semantics?: "navigation" | "filter"
  variant?: "default" | "toc"
}

export type SideNavItemProps =
  | (SideNavItemBaseProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "disabled" | "onClick" | "style"> & { asChild?: false; label: ReactNode })
  | (SideNavItemBaseProps & Omit<HTMLAttributes<HTMLElement>, "children" | "onClick" | "style"> & { asChild: true; label: ReactElement })

export const SideNavItem = forwardRef(function SideNavItem(
  { active = false, asChild = false, count, disabled = false, icon, label, onSelect, semantics = "navigation", tabIndex, variant = "default", ...props }: SideNavItemProps,
  ref: Ref<HTMLElement>,
) {
  const Component: ElementType = asChild ? Slot : "button"
  const ariaCurrent = active && semantics === "navigation"
    ? (variant === "toc" ? "location" : "page")
    : undefined
  const labelNode = asChild
    ? label
    : <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    onSelect?.()
  }

  return (
    <Component
      {...props}
      aria-current={ariaCurrent}
      aria-disabled={asChild && disabled ? true : undefined}
      aria-pressed={semantics === "filter" ? active : undefined}
      data-active={active ? "true" : "false"}
      data-mega-control="side-nav-item"
      data-variant={variant}
      disabled={asChild ? undefined : disabled}
      onClick={handleClick}
      ref={ref as Ref<HTMLButtonElement>}
      style={{ alignItems: "center", border: "none", borderLeft: variant === "toc" ? `2px solid ${active ? MEGA_TOKENS.accent : "transparent"}` : undefined, borderRadius: "var(--mega-radius-md)", color: active ? MEGA_TOKENS.activeFg : MEGA_TOKENS.text, cursor: disabled ? "not-allowed" : "pointer", display: "flex", fontSize: "var(--mega-density-font-size)", fontWeight: active ? 700 : 400, gap: MEGA_SPACING_TOKENS[6], minHeight: "var(--mega-density-row-height)", opacity: disabled ? 0.5 : 1, padding: "0 var(--mega-density-row-padding-x)", textAlign: "left", textDecoration: "none", width: "100%" }}
      tabIndex={asChild && disabled ? -1 : tabIndex}
      type={asChild ? undefined : "button"}
    >
      {icon}
      <Slottable>{labelNode}</Slottable>
      {count}
    </Component>
  )
})
