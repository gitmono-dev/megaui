"use client"

import { DIFFS_TAG_NAME, FileDiff, VirtualizedFileDiff, getFiletypeFromFileName, processFile, type FileDiffMetadata } from "@pierre/diffs"
import { Virtualizer, useVirtualizer, useWorkerPool } from "@pierre/diffs/react"
import { useEffect, useMemo, useRef } from "react"

import { isLikelyBinaryContent } from "./binary"
import { MEGA_CODE_THEMES, useMegaCodeThemeType } from "./theme"
import { MegaDiffsWorkerProvider } from "./worker-provider"

interface MegaPatchViewProps {
  path: string
  patch: string
  emptyLabel: string
  binaryLabel: string
}

const unifiedOptions = {
  diffStyle: "unified",
  diffIndicators: "classic",
  disableFileHeader: true,
  theme: MEGA_CODE_THEMES,
} as const

function readPatch(path: string, patch: string) {
  if (!patch.trim()) return { kind: "empty" } as const
  if (isLikelyBinaryContent(patch) || /^(?:GIT binary patch|Binary files(?: .+)? differ)\r?$/m.test(patch)) {
    return { kind: "binary" } as const
  }
  // Stored revision ranges can contain just the hunks; Pierre also expects a file header.
  const source = patch.startsWith("@@ ") ? `--- file\n+++ file\n${patch}` : patch
  try {
    const file = processFile(source, { throwOnError: true })
    if (file?.hunks.length) {
      // Pierre maps both complete basenames (Dockerfile, Makefile) and extensions.
      const lang = languageForPath(path)
      // Let Diffs choose a separate grammar for deletions when a rename changes languages.
      if (file.prevName && languageForPath(file.prevName) !== lang) {
        return { kind: "diff", file: { ...file, name: path } } as const
      }
      return { kind: "diff", file: { ...file, name: path, lang } } as const
    }
  } catch {
    // Keep the original text readable for historical or truncated patches.
  }
  return { kind: "raw" } as const
}

function languageForPath(path: string) {
  const name = path.split("/").pop() || path
  const language = getFiletypeFromFileName(name)
  return language === "text" ? getFiletypeFromFileName(name.toLowerCase()) : language
}

function HighlightedPatch({ file }: { file: FileDiffMetadata }) {
  const wrapper = useRef<HTMLDivElement>(null)
  const instance = useRef<FileDiff | null>(null)
  const workerPool = useWorkerPool()
  const virtualizer = useVirtualizer()
  const themeType = useMegaCodeThemeType()

  useEffect(() => {
    if (!wrapper.current) return
    // Each mount owns its host. A repeated React mount must never hydrate an empty diff shell.
    const host = document.createElement(DIFFS_TAG_NAME)
    // Give the virtualizer a top edge to anchor before the first highlighted rows arrive.
    if (virtualizer) host.style.minHeight = "1px"
    wrapper.current.appendChild(host)
    const diff = virtualizer
      ? new VirtualizedFileDiff(unifiedOptions, virtualizer, undefined, workerPool)
      : new FileDiff(unifiedOptions, workerPool)
    instance.current = diff
    diff.render({ fileDiff: file, fileContainer: host })
    return () => {
      diff.cleanUp()
      instance.current = null
    }
  }, [file, virtualizer, workerPool])

  useEffect(() => {
    instance.current?.setThemeType(themeType)
  }, [file, virtualizer, workerPool, themeType])
  return <div ref={wrapper} />
}

/** A single server-supplied patch, highlighted using its selected file's real path. */
export function MegaPatchView({ path, patch, emptyLabel, binaryLabel }: MegaPatchViewProps) {
  const parsed = useMemo(() => readPatch(path, patch), [path, patch])
  if (parsed.kind === "empty" || parsed.kind === "binary") {
    return <p role="status">{parsed.kind === "empty" ? emptyLabel : binaryLabel}</p>
  }
  if (parsed.kind === "raw") return <pre style={{ margin: 0, overflow: "auto" }}>{patch}</pre>

  const view = <HighlightedPatch file={parsed.file} />
  if (parsed.file.unifiedLineCount <= 400) return view
  return (
    <MegaDiffsWorkerProvider>
      <Virtualizer key={path} style={{ height: "75vh", overflow: "auto", overflowAnchor: "none" }}>{view}</Virtualizer>
    </MegaDiffsWorkerProvider>
  )
}
