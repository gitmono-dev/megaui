import type { SVGProps } from "react";

import { ShellIcon, type ShellIconName } from "@megaui/ui/shell";

const LOCAL_ICON_NAMES = [
  "check",
  "chevron-down",
  "clock",
  "edit",
  "eye",
  "filter",
  "history",
  "layers",
  "share",
  "stack",
  "users",
] as const;

export type DocsIconName = ShellIconName | (typeof LOCAL_ICON_NAMES)[number];

export interface DocsIconProps
  extends Omit<
    SVGProps<SVGSVGElement>,
    "children" | "color" | "fill" | "height" | "stroke" | "viewBox" | "width"
  > {
  name: DocsIconName;
  size?: number;
  color?: string;
}

function isShellIconName(name: DocsIconName): name is ShellIconName {
  return !LOCAL_ICON_NAMES.includes(name as (typeof LOCAL_ICON_NAMES)[number]);
}

/** ShellIcon plus the v6 docs-library glyphs the shell subset does not ship. */
export function DocsIcon({ name, size = 16, color = "currentColor", ...props }: DocsIconProps) {
  if (isShellIconName(name)) {
    return <ShellIcon aria-hidden={props["aria-hidden"]} color={color} name={name} size={size} />;
  }

  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };

  switch (name) {
    case "check":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "filter":
      return (
        <svg {...common}>
          <path d="M4 5h16l-6 8v5l-4 1v-6L4 5Z" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <path d="m12 3 8 4-8 4-8-4 8-4Z" />
          <path d="m4 12 8 4 8-4" />
          <path d="m4 16 8 4 8-4" />
        </svg>
      );
    case "share":
      return (
        <svg {...common}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="m8.6 13.5 6.8 4" />
          <path d="m15.4 6.5-6.8 4" />
        </svg>
      );
    case "stack":
      return (
        <svg {...common}>
          <rect height="5" rx="1" width="16" x="4" y="4" />
          <rect height="5" rx="1" width="16" x="4" y="10" />
          <rect height="5" rx="1" width="16" x="4" y="16" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 19a6 6 0 0 1 12 0" />
          <circle cx="17" cy="9" r="2.4" />
          <path d="M21 19a5 5 0 0 0-6-4.7" />
        </svg>
      );
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}
