"use client"

/**
 * megaui:libs/react-shared/components/mega/code-view/code-block.tsx@0ff3a9d
 *
 * Adapted: token import path (`@libs/ui/mega-tokens` -> local `../tokens`).
 */
import { File } from "@pierre/diffs/react"

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import { MEGA_CODE_THEMES, useMegaCodeThemeType } from "./theme"

export interface MegaCodeBlockProps {
  language?: string
  /** Dual-theme Shiki HTML from an SSR preload path (no highlight flash). */
  prerenderedHTML?: string
  text: string
}

const EXTENSIONS: Record<string, string> = {
  bash: "sh",
  "c++": "cpp",
  "c#": "cs",
  csharp: "cs",
  javascript: "js",
  javascriptreact: "jsx",
  markdown: "md",
  python: "py",
  rust: "rs",
  shell: "sh",
  toml: "toml",
  typescript: "ts",
  typescriptreact: "tsx",
}

/**
 * Headerless, unnumbered Shiki block for prose/README contexts, built on
 * the shared @pierre/diffs engine. Works with or without
 * `MegaDiffsWorkerProvider` above it (falls back to main-thread
 * highlighting when no worker pool is mounted).
 */
export function MegaCodeBlock({ language, prerenderedHTML, text }: MegaCodeBlockProps) {
  const themeType = useMegaCodeThemeType()
  const normalizedLanguage = language?.trim().toLowerCase()
  const extension = EXTENSIONS[normalizedLanguage ?? ""] ?? normalizedLanguage ?? "txt"

  return (
    <div
      data-mega-code-block={language ?? "plain"}
      style={{
        background: MEGA_TOKENS.codeBg,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2)`,
        fontSize: "var(--mega-density-code-font-size)",
        lineHeight: "var(--mega-density-code-line-height)",
        margin: `${MEGA_SPACING_TOKENS[6]} 0 calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        overflow: "auto",
        padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]})`,
      }}
    >
      <File
        file={{ contents: text, name: `block.${extension}` }}
        options={{
          disableFileHeader: true,
          disableLineNumbers: true,
          disableVirtualizationBuffers: true,
          overflow: "wrap",
          theme: MEGA_CODE_THEMES,
          themeType,
        }}
        prerenderedHTML={prerenderedHTML}
      />
    </div>
  )
}
