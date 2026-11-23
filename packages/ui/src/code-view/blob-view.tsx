"use client"

/**
 * New for UI-08. Not an upstream port (the apps/next-app code-tab.tsx
 * equivalent lives outside this card's reference source of
 * libs/react-shared/components/mega/code-view/**) — built on the
 * ported MegaCodeBlock/theme/themes-shared primitives above and the
 * @pierre/diffs File component.
 */
import { File } from "@pierre/diffs/react"
import type { SelectedLineRange } from "@pierre/diffs"
import { useCallback, useState } from "react"

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import { isLikelyBinaryContent } from "./binary"
import { MEGA_CODE_THEMES, useMegaCodeThemeType, type MegaCodeThemeType } from "./theme"

export interface MegaBlobViewFile {
  name: string
  contents: string
  /** Shiki language id. Omitted or `plaintext` leaves language inference to the filename. */
  language?: string
}

function highlightLanguage(language: string | undefined): string | undefined {
  const normalized = language?.trim().toLowerCase()
  if (!normalized || normalized === "plain" || normalized === "plaintext" || normalized === "text") return undefined
  return normalized
}

export interface MegaBlobViewLabels {
  copy: string
  copied: string
  binaryFallback: string
}

export interface MegaBlobViewProps {
  file: MegaBlobViewFile
  labels: MegaBlobViewLabels
  /** Dual-theme Shiki HTML from an SSR preload path (no highlight flash). */
  prerenderedHTML?: string
  /** Controlled line selection, e.g. hydrated from a parsed `#L42-L50` hash (see `./line-anchor`). */
  selectedLines?: SelectedLineRange | null
  onSelectedLinesChange?(range: SelectedLineRange | null): void
  /** Skips Shiki and renders raw numbered `<pre>` text — for oversized files or an explicit opt-out. */
  forcePlainText?: boolean
  themeType?: MegaCodeThemeType
}

const COPY_RESET_MS = 2_000

interface PlainTextBlobProps {
  contents: string
  onSelectedLinesChange?(range: SelectedLineRange | null): void
  selectedLines: SelectedLineRange | null
}

/** Plaintext fallback: no Shiki, but the same line-anchor contract (click a line number to select it). */
function PlainTextBlob({ contents, onSelectedLinesChange, selectedLines }: PlainTextBlobProps) {
  const lines = contents.split("\n")

  return (
    <pre
      data-mega-blob="plaintext"
      style={{ fontFamily: MEGA_TOKENS.fontMono, fontSize: "var(--mega-density-code-font-size)", margin: 0, overflow: "auto", padding: MEGA_SPACING_TOKENS[8] }}
    >
      {lines.map((line, lineIndex) => {
        const lineNumber = lineIndex + 1
        const selected = selectedLines != null && lineNumber >= selectedLines.start && lineNumber <= selectedLines.end
        return (
          <div
            data-line-number={lineNumber}
            data-selected={selected ? "true" : "false"}
            key={lineNumber}
            onClick={() => onSelectedLinesChange?.({ end: lineNumber, start: lineNumber })}
            style={{
              background: selected ? MEGA_TOKENS.activeBg : undefined,
              cursor: onSelectedLinesChange ? "pointer" : undefined,
              display: "flex",
              gap: MEGA_SPACING_TOKENS[8],
            }}
          >
            <span aria-hidden="true" style={{ color: MEGA_TOKENS.muted, minWidth: 24, textAlign: "right", userSelect: "none" }}>
              {lineNumber}
            </span>
            <span>{line}</span>
          </div>
        )
      })}
    </pre>
  )
}

/**
 * Blob (single-file) viewer: Shiki highlighting with line-number anchors
 * (`selectedLines` in, `onSelectedLinesChange` out — pair with
 * `./line-anchor`'s `parseLineAnchor`/`formatLineAnchor` for `#L42-L50`
 * deep links), a copy-to-clipboard action, and fallbacks for binary
 * content or files too large/unsupported to highlight.
 */
export function MegaBlobView({
  file,
  forcePlainText = false,
  labels,
  onSelectedLinesChange,
  prerenderedHTML,
  selectedLines,
  themeType,
}: MegaBlobViewProps) {
  const detectedThemeType = useMegaCodeThemeType()
  const resolvedThemeType = themeType ?? detectedThemeType
  const [copied, setCopied] = useState(false)
  const isBinary = isLikelyBinaryContent(file.contents)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(file.contents).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), COPY_RESET_MS)
    })
  }, [file.contents])

  return (
    <div data-mega-blob="root" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        data-mega-blob="toolbar"
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          display: "flex",
          fontSize: "calc(var(--mega-density-font-size) - 1px)",
          gap: MEGA_SPACING_TOKENS[6],
          padding: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[8]}`,
        }}
      >
        <span style={{ color: MEGA_TOKENS.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
        <span style={{ flex: 1 }} />
        <button data-mega-blob="copy" onClick={handleCopy} type="button">
          {copied ? labels.copied : labels.copy}
        </button>
      </div>
      {isBinary ? (
        <p data-mega-blob="binary-fallback" role="status" style={{ color: MEGA_TOKENS.muted, margin: 0, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
          {labels.binaryFallback}
        </p>
      ) : forcePlainText ? (
        <PlainTextBlob contents={file.contents} onSelectedLinesChange={onSelectedLinesChange} selectedLines={selectedLines ?? null} />
      ) : (
        <File
          disableWorkerPool
          file={{
            contents: file.contents,
            lang: highlightLanguage(file.language),
            name: file.name,
          }}
          options={{
            disableFileHeader: true,
            enableLineSelection: true,
            onLineSelected: onSelectedLinesChange,
            preferredHighlighter: "shiki-js",
            theme: MEGA_CODE_THEMES,
            themeType: resolvedThemeType,
          }}
          prerenderedHTML={prerenderedHTML}
          selectedLines={selectedLines}
        />
      )}
    </div>
  )
}
