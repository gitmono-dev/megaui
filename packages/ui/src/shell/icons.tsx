/**
 * megaui:libs/react-shared/components/mega/icons.tsx@0ff3a9d (subset)
 *
 * Bespoke, dependency-free SVG icon set for the workspace shell/palette.
 * Upstream's `MegaIcon` covers ~47 names; this port keeps only the subset
 * the shell/palette/favorites contract actually renders (GC-03 diff —
 * narrower name union, same path data for shared names) so
 * `packages/ui/src/shell/**` never needs a new icon-set dependency.
 */
import type { SVGProps } from "react"

export const SHELL_ICON_NAMES = [
  "book",
  "bug",
  "chat",
  "code",
  "diamond",
  "file",
  "folder",
  "git-pull",
  "hash",
  "home",
  "inbox",
  "more",
  "plus",
  "search",
  "sparkle",
  "star",
  "tag",
  "terminal",
  "x",
] as const

export type ShellIconName = (typeof SHELL_ICON_NAMES)[number]

export interface ShellIconProps
  extends Omit<
    SVGProps<SVGSVGElement>,
    | "children"
    | "color"
    | "fill"
    | "height"
    | "stroke"
    | "strokeLinecap"
    | "strokeLinejoin"
    | "strokeWidth"
    | "viewBox"
    | "width"
  > {
  name: ShellIconName
  size?: number
  color?: string
  strokeWidth?: number
}

export function ShellIcon({
  name,
  size = 16,
  color = "currentColor",
  strokeWidth = 1.6,
  ...props
}: ShellIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  }

  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1v-9.5Z" />
        </svg>
      )
    case "inbox":
      return (
        <svg {...common}>
          <path d="M3 12h5l1.5 2.5h5L16 12h5" />
          <path d="M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2-7Z" />
        </svg>
      )
    case "book":
      return (
        <svg {...common}>
          <path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4V4Z" />
          <path d="M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8V4Z" />
        </svg>
      )
    case "code":
      return (
        <svg {...common}>
          <path d="m8 7-5 5 5 5" />
          <path d="m16 7 5 5-5 5" />
          <path d="m14 5-4 14" />
        </svg>
      )
    case "tag":
      return (
        <svg {...common}>
          <path d="M20.5 13.5 13 21 3 11V3h8l9.5 9.5a1 1 0 0 1 0 1.4Z" />
          <circle cx="7.5" cy="7.5" r="1.5" />
        </svg>
      )
    case "git-pull":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <path d="M6 8.5v7" />
          <path d="M18 8v7.5" />
          <path d="M14 6h2a2 2 0 0 1 2 2" />
          <path d="m12 4 2 2-2 2" />
        </svg>
      )
    case "bug":
      return (
        <svg {...common}>
          <rect x="6" y="7" width="12" height="13" rx="5" />
          <path d="M3 11h3m12 0h3M3 17h3m12 0h3M5 5l2 2m12-2-2 2M10 5h4" />
        </svg>
      )
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      )
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      )
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      )
    case "file":
      return (
        <svg {...common}>
          <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
          <path d="M14 3v4h4" />
        </svg>
      )
    case "star":
      return (
        <svg {...common}>
          <path d="m12 3 2.9 5.9 6.6.9-4.8 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.5 9.8l6.6-.9L12 3Z" />
        </svg>
      )
    case "hash":
      return (
        <svg {...common}>
          <path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" />
        </svg>
      )
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )
    case "more":
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1.2" fill={color} />
          <circle cx="12" cy="12" r="1.2" fill={color} />
          <circle cx="19" cy="12" r="1.2" fill={color} />
        </svg>
      )
    case "x":
      return (
        <svg {...common}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      )
    case "chat":
      return (
        <svg {...common}>
          <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
        </svg>
      )
    case "terminal":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h5" />
        </svg>
      )
    case "diamond":
      return (
        <svg {...common}>
          <path d="m12 2 10 10-10 10L2 12 12 2Z" />
        </svg>
      )
    default: {
      const exhaustive: never = name
      return exhaustive
    }
  }
}
