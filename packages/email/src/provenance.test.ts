import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-level guard (GC-03 / GC-13): package production source files must
// never carry a `tinyship` or legacy-frontend token. This is stricter than the
// rendered-output guard in `brand-residue.test.ts` — it also covers
// file-header comments.
//
// Scope: non-test `.ts` files only. Test files that *define* a brand-word
// guard (this file, `brand-residue.test.ts`) necessarily reference the
// banned tokens literally in prose/regexes — mirroring how `@megaui/i18n`'s
// own `brand-residue.test.ts` only scans dictionary *values*, never its own
// source.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_FRONTEND = new RegExp(["mono", "ui"].join(""), "i");

function listProductionSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".turbo") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listProductionSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("source-level brand/provenance guard (GC-03)", () => {
  const files = listProductionSourceFiles(SRC_DIR);

  it("found source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has zero 'tinyship' occurrences anywhere in production source", () => {
    const hits = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => /tinyship/i.test(content))
      .map(({ file }) => file);
    expect(hits).toEqual([]);
  });

  it("has zero legacy-frontend occurrences anywhere in production source", () => {
    const hits = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => LEGACY_FRONTEND.test(content))
      .map(({ file }) => file);
    expect(hits).toEqual([]);
  });
});
