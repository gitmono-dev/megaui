import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const PROVENANCE_RE = /^\/\/ megaui:[A-Za-z0-9_./-]+@[0-9a-f]+(?:\s.*)?$/m;
const OWN_PROVENANCE_RE = /^\/\/ megaui-only \(FS-[1-9][0-9]*\): [^\r\n]+\r?\n/;

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
    if (entry.name === "index.ts" || entry.name === "client.ts") continue;
    files.push(full);
  }
  return files;
}

describe("provenance headers (PK-06 / GC-03)", () => {
  it("requires upstream provenance or an explicit enterprise-otp FS source marker", () => {
    const files = listProductionTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const relative = path.relative(srcDir, file);
      expect(text, relative).toMatch(relative.startsWith(`enterprise-otp${path.sep}`)
        ? OWN_PROVENANCE_RE : PROVENANCE_RE);
    }
  });
});
