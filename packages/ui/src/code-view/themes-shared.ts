/**
 * megaui:libs/react-shared/components/mega/code-view/themes-shared.ts@0ff3a9d
 *
 * Server-safe Shiki dual-theme constant (ADR-WS-03). The client hook lives
 * in `./theme`; SSR preload paths (out of scope for this card, see WA-08)
 * import from here to avoid the client boundary.
 */
export const MEGA_CODE_THEMES = { dark: "github-dark", light: "github-light" } as const

export type MegaCodeThemeType = "dark" | "light"
