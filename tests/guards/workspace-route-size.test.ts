import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(__dirname, "../..");
const MAX_PURE_LINES = 250;
const WORKSPACE_ROUTE_FILES = [
  "apps/web/app/[lang]/workspace/issues/page.tsx",
  "apps/web/app/[lang]/workspace/issues/[n]/page.tsx",
  "apps/web/app/[lang]/workspace/agent/[threadId]/page.tsx",
  "apps/web/app/[lang]/workspace/code/[...path]/page.tsx",
] as const;

function countPureLines(source: string): number {
  let inBlockComment = false;
  let count = 0;

  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) count += 1;
  }

  return count;
}

describe("workspace route size guard", () => {
  it("keeps each refactored workspace route within the 250 pure-LOC ceiling", () => {
    // Given: the four routes whose data orchestration and layout were mixed together.
    const counts = WORKSPACE_ROUTE_FILES.map((file) => ({
      file,
      lines: countPureLines(readFileSync(resolve(REPOSITORY_ROOT, file), "utf8")),
    }));

    // When: the architecture guard measures the route modules.
    const oversized = counts.filter(({ lines }) => lines > MAX_PURE_LINES);

    // Then: each route remains a small orchestrator instead of regressing into a page dump.
    expect(oversized).toEqual([]);
  });
});
