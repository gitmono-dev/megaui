import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_FRONTEND = new RegExp(["mono", "ui"].join(""), "i");

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
    files.push(full);
  }
  return files;
}

describe("brand residue (PK-06)", () => {
  it("keeps tinyship and the legacy frontend name out of production sources", () => {
    const files = listProductionTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/tinyship/i);

      expect(text, file).not.toMatch(LEGACY_FRONTEND);
    }
  });
});
