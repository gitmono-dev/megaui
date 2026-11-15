import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const PROVENANCE_RE = /^\/\/ megaui:[A-Za-z0-9_./-]+@[0-9a-f]+(?:\s.*)?$/m;

function listProductionTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionTsFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name === "index.ts") continue;
    files.push(full);
  }
  return files;
}

describe("provenance headers (EG-01 / GC-03)", () => {
  it("annotates every non-barrel production source with megaui:<path>@<sha> or megaui-only", () => {
    const files = listProductionTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const relative = path.relative(srcDir, file);
      // A MegaUI-only source declares itself instead of naming an upstream
      // file, which is what the title of this case has always described.
      if (text.split("\n")[0]?.startsWith("// megaui-only")) continue;
      if (relative === "context.ts") {
        expect(text, relative).toMatch(/^\/\/ megaui-only \(EG-01\)/m);
        continue;
      }
      if (relative === "services/docs/block-reference.ts") {
        expect(text, relative).toMatch(/^\/\/ megaui-only \(Roam inline block references\)/m);
        continue;
      }
      expect(text, relative).toMatch(PROVENANCE_RE);
    }
  });
});
