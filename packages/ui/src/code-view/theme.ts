"use client"

/**
 * megaui:libs/react-shared/components/mega/code-view/theme.ts@0ff3a9d
 *
 * Adapted: upstream useMegaCodeThemeType reads an app-level useTheme()
 * context that @megaui/ui doesn't have (this card's write set is limited
 * to packages/ui/src/{code-view,file-tree}). Instead this reads the same
 * dark document-root class this package's own theme module
 * (../tokens/themes.ts, applyThemeToDocument) already applies, so it
 * works standalone or underneath that provider with no extra wiring.
 */
import { useEffect, useState } from "react"

import { MEGA_CODE_THEMES, type MegaCodeThemeType } from "./themes-shared"

export { MEGA_CODE_THEMES }
export type { MegaCodeThemeType }

function readThemeType(): MegaCodeThemeType {
  if (typeof document === "undefined") return "light"
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

export function useMegaCodeThemeType(): MegaCodeThemeType {
  const [themeType, setThemeType] = useState<MegaCodeThemeType>(readThemeType)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setThemeType(readThemeType()))
    observer.observe(root, { attributeFilter: ["class"], attributes: true })
    return () => observer.disconnect()
  }, [])

  return themeType
}
