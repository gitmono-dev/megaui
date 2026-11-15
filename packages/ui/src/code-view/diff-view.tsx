"use client"

/**
 * New for UI-08. Not an upstream port (the apps/next-app CL files client
 * equivalent lives outside this card's reference source of
 * libs/react-shared/components/mega/code-view/**) — built on the
 * ported theme/themes-shared primitives above and @pierre/diffs'
 * FileDiff + parseDiffFromFile.
 */
import type { FileDiffMetadata } from "@pierre/diffs"
import { parseDiffFromFile } from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"
import { useMemo } from "react"

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import { isLikelyBinaryContent } from "./binary"
import { MEGA_CODE_THEMES, useMegaCodeThemeType, type MegaCodeThemeType } from "./theme"

export interface MegaDiffViewFile {
  name: string
  contents: string
}

export interface MegaDiffViewLabels {
  binaryFallback: string
  /** `{from}`/`{to}` tokens are replaced with the previous/new file paths. */
  renamed: string
}

export interface MegaDiffViewProps {
  /** Old (pre-change) file contents, or `null` for a newly added file. */
  oldFile: MegaDiffViewFile | null
  /** New (post-change) file contents, or `null` for a deleted file. */
  newFile: MegaDiffViewFile | null
  labels: MegaDiffViewLabels
  prerenderedHTML?: string
  diffStyle?: "split" | "unified"
  themeType?: MegaCodeThemeType
}

/**
 * File diff viewer: renders add/delete/modify/rename hunks via
 * `@pierre/diffs`, with a binary fallback (NUL-byte sniffed, see
 * `./binary`) instead of attempting to diff/highlight non-text content.
 */
export function MegaDiffView({ diffStyle = "unified", labels, newFile, oldFile, prerenderedHTML, themeType }: MegaDiffViewProps) {
  const detectedThemeType = useMegaCodeThemeType()
  const resolvedThemeType = themeType ?? detectedThemeType

  const isBinary = isLikelyBinaryContent(oldFile?.contents ?? "") || isLikelyBinaryContent(newFile?.contents ?? "")

  const fileDiff = useMemo<FileDiffMetadata | undefined>(() => {
    if (isBinary || (!oldFile && !newFile)) return undefined
    return parseDiffFromFile(oldFile, newFile)
  }, [isBinary, oldFile, newFile])

  if (!fileDiff) {
    const name = newFile?.name ?? oldFile?.name ?? ""
    return (
      <div
        data-mega-diff="binary-fallback"
        role="status"
        style={{ alignItems: "center", color: MEGA_TOKENS.muted, display: "flex", gap: MEGA_SPACING_TOKENS[6], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
      >
        <span style={{ color: MEGA_TOKENS.text, fontWeight: 600 }}>{name}</span>
        <span>{labels.binaryFallback}</span>
      </div>
    )
  }

  const isRenamed = fileDiff.type === "rename-pure" || fileDiff.type === "rename-changed"

  return (
    <div data-mega-diff="root" data-mega-diff-type={fileDiff.type}>
      {isRenamed ? (
        <div
          data-mega-diff="rename-banner"
          style={{
            borderBottom: `1px solid ${MEGA_TOKENS.border}`,
            color: MEGA_TOKENS.muted,
            fontSize: "calc(var(--mega-density-font-size) - 1px)",
            padding: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[8]}`,
          }}
        >
          {labels.renamed.replace("{from}", fileDiff.prevName ?? "").replace("{to}", fileDiff.name)}
        </div>
      ) : null}
      <FileDiff fileDiff={fileDiff} options={{ diffStyle, disableFileHeader: true, theme: MEGA_CODE_THEMES, themeType: resolvedThemeType }} prerenderedHTML={prerenderedHTML} />
    </div>
  )
}
