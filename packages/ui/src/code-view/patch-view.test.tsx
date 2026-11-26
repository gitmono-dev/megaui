// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest"
import { getFiletypeFromFileName, type FileDiffMetadata } from "@pierre/diffs"
import { cleanup, render, screen } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, assert, describe, expect, it, vi } from "vitest"

import { MegaPatchView } from "./patch-view"

const { cleanUp, renderFile } = vi.hoisted(() => ({
  cleanUp: vi.fn(),
  renderFile: vi.fn<(props: { fileContainer: HTMLElement; fileDiff: FileDiffMetadata }) => boolean>(() => true),
}))

vi.mock("@pierre/diffs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pierre/diffs")>(),
  FileDiff: class {
    cleanUp = cleanUp
    render = renderFile
    setThemeType = vi.fn()
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const labels = { emptyLabel: "No patch available", binaryLabel: "Binary file" }
const hunk = "@@ -11,2 +21,2 @@\n anchor\n-old\n+new\n"

function renderedFile() {
  const props = renderFile.mock.lastCall?.[0]
  assert.isDefined(props)
  return props.fileDiff
}

describe("MegaPatchView", () => {
  it.each([
    ["libra/deploy/Dockerfile", "dockerfile"],
    ["libra/tools/Makefile", "makefile"],
    ["libra/src/MAIN.RS", "rust"],
    ["libra/notes/NOTICE", "text"],
  ])("selects the %s syntax from the file path", (path, language) => {
    const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}`
    render(<MegaPatchView {...labels} path={path} patch={patch} />)

    const file = renderedFile()
    expect(file.name).toBe(path)
    expect(file.lang ?? getFiletypeFromFileName(file.name)).toBe(language)
  })

  it("preserves both file types when an edited JSON file is renamed to TypeScript", () => {
    const patch = `diff --git a/cfg.json b/cfg.ts
similarity index 77%
rename from cfg.json
rename to cfg.ts
index edbe30f..c7041bf 100644
--- a/cfg.json
+++ b/cfg.ts
@@ -1,4 +1,4 @@
-{
+export default {
   "name": "test",
   "mode": "release",
   "strict": true
`
    render(<MegaPatchView {...labels} path="cfg.ts" patch={patch} />)
    const file = renderedFile()
    expect(file).toMatchObject({ prevName: "cfg.json", name: "cfg.ts", type: "rename-changed" })
    expect(file.lang).toBeUndefined()
  })

  it("preserves old and new coordinates and context in a hunk-only patch", () => {
    render(<MegaPatchView {...labels} path="src/lib.rs" patch={hunk} />)

    const file = renderedFile()
    expect(file.name).toBe("src/lib.rs")
    expect(file.type).toBe("change")
    expect(file.hunks).toMatchObject([{ deletionStart: 11, additionStart: 21, deletionLines: 1, additionLines: 1 }])
    expect(file.deletionLines).toEqual(["anchor\n", "old\n"])
    expect(file.additionLines).toEqual(["anchor\n", "new\n"])
  })

  it("mounts into a fresh host when StrictMode recreates the renderer on the first page load", () => {
    const { container, unmount } = render(
      <StrictMode><MegaPatchView {...labels} path="src/lib.rs" patch={hunk} /></StrictMode>,
    )
    const hosts = renderFile.mock.calls.map(([{ fileContainer }]) => fileContainer)
    expect(hosts).toHaveLength(2)
    const [first, second] = hosts
    assert.isDefined(second)
    expect(second).not.toBe(first)
    expect(container).toContainElement(second)
    expect(cleanUp).toHaveBeenCalledTimes(1)
    unmount()
    expect(cleanUp).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["Mega2 binary summary", "diff --git a/banner.png b/banner.png\nnew file mode 100644\nBinary files differ\n"],
    ["Git binary summary", "diff --git a/image b/image\nBinary files a/image and b/image differ\n"],
    ["Git binary payload", "diff --git a/image b/image\nGIT binary patch\nliteral 4\nLc\n"],
    ["NUL byte", "PNG\u0000IHDR"],
  ])("shows the binary fallback for %s", (_, patch) => {
    render(<MegaPatchView {...labels} path="image" patch={patch} />)
    expect(screen.getByRole("status")).toHaveTextContent(labels.binaryLabel)
    expect(renderFile).not.toHaveBeenCalled()
  })

  it.each([
    ["malformed patch", "@@ broken hunk header @@\n+preserve this line\n"],
    ["rename without hunks", "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n"],
  ])("keeps the original text of a %s", (_, patch) => {
    const { container } = render(<MegaPatchView {...labels} path="new.txt" patch={patch} />)
    expect(container.querySelector("pre")?.textContent).toBe(patch)
    expect(renderFile).not.toHaveBeenCalled()
  })

  it("shows the empty label when the patch contains only whitespace", () => {
    render(<MegaPatchView {...labels} path="src/lib.rs" patch={" \n"} />)
    expect(screen.getByRole("status")).toHaveTextContent(labels.emptyLabel)
    expect(renderFile).not.toHaveBeenCalled()
  })
})
