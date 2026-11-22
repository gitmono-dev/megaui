import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_DOC = path.resolve(srcDir, "../../../docs/implementation/feishu-login.md");
const PROVENANCE_RE = /^\/\/ megaui:[A-Za-z0-9_./-]+@[0-9a-f]+(?:\s.*)?$/m;
const SOURCES_NOTE = "; 原参照见 docs/implementation/feishu-login.md「来源」)";

/**
 * FSL-133: the Feishu login files whose original reference moved into the 「来源」 table of
 * `docs/implementation/feishu-login.md`. `header` is the exact first line each file has now;
 * `original` is, verbatim, the first line it had before FSL-133 (for `code.ts`, the first line
 * of the file it was moved from).
 */
const FEISHU_LOGIN_SOURCES = [
  {
    file: "feishu-login/plugin.ts",
    header: `// megaui-only (FSL-123, FSL-124: the feishuLogin Better Auth plugin${SOURCES_NOTE}`,
    original: "// megaui:packages/auth/src/enterprise-otp/plugin.ts@24a8551 (megaui-only FSL-123, FSL-124: the feishuLogin Better Auth plugin)",
  },
  {
    file: "feishu-login/request.ts",
    header: `// megaui-only (FSL-123, FSL-154, FSL-161: the request contract of the Feishu login${SOURCES_NOTE}`,
    original: "// megaui:packages/auth/src/enterprise-otp/request.ts@24a8551 (megaui-only FSL-123, FSL-154, FSL-161: the request contract of the Feishu login)",
  },
  {
    file: "feishu-login/verify.ts",
    header: `// megaui-only (FSL-124, FSL-151, FSL-125, FSL-152, FSL-169, FSL-161: the verify endpoint of the Feishu login${SOURCES_NOTE}`,
    original: "// megaui:packages/auth/src/enterprise-otp/verify.ts@24a8551 (megaui-only FSL-124, FSL-151, FSL-125, FSL-152, FSL-169, FSL-161: the verify endpoint of the Feishu login)",
  },
  {
    file: "feishu-login/policy.ts",
    header: `// megaui-only (FSL-127: the Feishu-mode operation allowlist${SOURCES_NOTE}`,
    original: "// megaui:packages/auth/src/enterprise-otp/policy.ts@ac1f445 (megaui-only FSL-127: the Feishu-mode operation allowlist)",
  },
  {
    file: "feishu-login/cookie.ts",
    header: `// megaui-only (FSL-123: the Feishu login flow cookie${SOURCES_NOTE}`,
    original: "// megaui:packages/auth/src/enterprise-otp/plugin.ts@24a8551 (megaui-only FSL-123: the Feishu login flow cookie)",
  },
  {
    file: "feishu-login/input.ts",
    header: `// megaui-only (FSL-123: email admission of the Feishu login request${SOURCES_NOTE}`,
    original: "// megaui:packages/auth/src/enterprise-otp/input.ts@24a8551 (megaui-only FSL-123: email admission of the Feishu login request)",
  },
  {
    file: "feishu-login/code.ts",
    header: `// megaui-only (FS-35: CSPRNG generation and the single canonical OTP predicate${SOURCES_NOTE}`,
    original: "// megaui-only (FS-35): CSPRNG generation and the single canonical OTP predicate.",
  },
] as const;

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

function relativeKey(file: string): string {
  return path.relative(srcDir, file).split(path.sep).join("/");
}

describe("provenance headers (PK-06 / GC-03)", () => {
  it("requires upstream provenance on every file outside the Feishu login sources table", () => {
    const sourced = new Set<string>(FEISHU_LOGIN_SOURCES.map(entry => entry.file));
    const files = listProductionTsFiles(srcDir).filter(file => !sourced.has(relativeKey(file)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), relativeKey(file)).toMatch(PROVENANCE_RE);
    }
  });

  it("FSL-133: lists every Feishu login production file in the sources table", () => {
    const feishu = listProductionTsFiles(path.join(srcDir, "feishu-login")).map(relativeKey).sort();
    expect(feishu).toEqual(FEISHU_LOGIN_SOURCES.map(entry => entry.file).sort());
  });

  it.each(FEISHU_LOGIN_SOURCES)("FSL-133: $file points its first line at the 「来源」 table", ({ file, header }) => {
    const firstLine = readFileSync(path.join(srcDir, file), "utf8").split(/\r?\n/, 1)[0];
    expect(firstLine).toBe(header);
  });

  it.each(FEISHU_LOGIN_SOURCES)("FSL-133: the 「来源」 row of $file keeps its original first line verbatim", ({ file, original }) => {
    const lines = readFileSync(SOURCES_DOC, "utf8").split(/\r?\n/);
    const heading = lines.indexOf("## 来源");
    expect(heading).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
    const section = lines.slice(heading + 1, end === -1 ? undefined : end);
    const rows = section.filter(line => line.startsWith(`| \`packages/auth/src/${file}\` |`));
    expect(rows).toEqual([`| \`packages/auth/src/${file}\` | \`${original}\` |`]);
  });
});
