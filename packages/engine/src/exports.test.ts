import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.resolve(here, "../package.json"), "utf8"),
) as { exports: Record<string, string>; dependencies: Record<string, string> };

describe("package exports and ADR-ARCH-01 deps (EG-01)", () => {
  it("exposes fixtures only on the /testing subpath", () => {
    expect(packageJson.exports["."]).toBe("./src/index.ts");
    expect(packageJson.exports["./testing"]).toBe("./src/testing/index.ts");
    const root = readFileSync(path.resolve(here, "index.ts"), "utf8");
    expect(root).not.toMatch(/testing/);
    expect(root).not.toMatch(/USERS|SAMPLE_DOC|FIXTURE_NOW|seedMega/);
  });

  it("keeps fixture symbols off the root barrel at runtime", async () => {
    const root = await import("./index");
    expect("USERS" in root).toBe(false);
    expect("SAMPLE_DOC" in root).toBe(false);
    expect("CURRENT_USER" in root).toBe(false);
    const testing = await import("./testing/index");
    expect(testing.USERS.tianjing.username).toBe("tianjing");
    expect(testing.SAMPLE_DOC.id).toBe("doc_arch_overview");
    expect(testing.SAMPLE_CL.number).toBe(1);
    expect(testing.SAMPLE_MESSAGES.length).toBeGreaterThan(0);
  });

  it("depends only on the allowed mid-tier packages plus zod/drizzle/the EG-12 LLM provider", () => {
    const names = Object.keys(packageJson.dependencies).sort();
    expect(names).toEqual(
      [
        // ADR-ARCH-06 (EG-12): the one third-party dependency this repo's
        // agent domain needs — an openai-compatible `LanguageModelV4`
        // client, not a DeepSeek-specific SDK.
        "@ai-sdk/openai-compatible",
        "@megaui/content",
        "@megaui/core",
        "@megaui/database",
        // FS-31: the enterprise login notification sender lives in @megaui/email.
        "@megaui/email",
        "drizzle-orm",
        // FS-80: the admin CLI and enterprise worker open PostgreSQL directly.
        "pg",
        "tsx",
        "zod",
      ].sort(),
    );
    expect(names).not.toContain("@megaui/ui");
    expect(names).not.toContain("@megaui/web");
  });

  it("does not let the root barrel resolve fixture files via require.resolve", () => {
    const require = createRequire(import.meta.url);
    const rootEntry = require.resolve("@megaui/engine");
    const testingEntry = require.resolve("@megaui/engine/testing");
    expect(rootEntry).toContain(`${path.sep}src${path.sep}index.ts`);
    expect(testingEntry).toContain(`${path.sep}testing${path.sep}index.ts`);
    expect(rootEntry).not.toBe(testingEntry);
  });
});
