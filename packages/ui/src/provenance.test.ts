import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// UI-01 AC1 (brand-residue guard) + GC-03 (provenance-form guard).
//
// Scope: every non-test production source file under `packages/ui/src`
// (`.ts`, `.tsx`, `.css`) — tokens, styles, and icons all carry ported
// content, so both `.ts`/`.tsx` headers and `.css` comment headers must be
// scanned. Test files that *define* a brand-word guard (this file) are
// excluded, mirroring `@megaui/email`'s `provenance.test.ts` /
// `brand-residue.test.ts` pattern.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_FRONTEND = new RegExp(["mono", "ui"].join(""), "i");
const SCANNABLE_EXTENSIONS = [".ts", ".tsx", ".css"];

function isTestFile(filename: string): boolean {
  return filename.endsWith(".test.ts") || filename.endsWith(".test.tsx");
}

function listProductionSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".turbo") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listProductionSourceFiles(full));
    } else if (SCANNABLE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !isTestFile(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("source-level brand/provenance guard (UI-01 AC1, GC-03)", () => {
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

  it("has zero 'wechat' occurrences (icon set is cut per the UI-01 card)", () => {
    const hits = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => /wechat/i.test(content))
      .map(({ file }) => file);
    expect(hits).toEqual([]);
  });
});
