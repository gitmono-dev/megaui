"use client"

/**
 * megaui:libs/react-shared/components/mega/code-view/worker-provider.tsx@0ff3a9d
 */
import { WorkerPoolContextProvider } from "@pierre/diffs/react"
import type { ReactNode } from "react"
import { MEGA_CODE_THEMES } from "./themes-shared"

/**
 * Shared @pierre/diffs worker pool (ADR-WS-03): Shiki highlighting runs off
 * the main thread for code views and diffs when this provider wraps the
 * tree. It is optional — `MegaBlobView`/`MegaDiffView`/`MegaCodeBlock` all
 * render correctly without it (main-thread highlighting, verified for
 * SSR-less and test environments), just without the worker-pool speedup.
 * The underlying pool is a module singleton shared across mounts.
 */
export function MegaDiffsWorkerProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      highlighterOptions={{ theme: MEGA_CODE_THEMES, langs: ["rust", "typescript", "javascript", "markdown", "toml", "shell", "json", "python", "text"] }}
      poolOptions={{
        poolSize: 2,
        workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" }),
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}
