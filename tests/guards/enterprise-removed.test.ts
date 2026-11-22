// megaui-only: zero-hit guards of the Phase 2 enterprise removal cards (plan-20261118).
//
// Each removal card owns one section below and later cards append their own. A section
// asserts that every path its card deletes is absent and runs the card's `rg` guard as a
// child process: exit 1 (no match) passes, exit 0 (a match) or >1 (an error) fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function rg(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("rg", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The file names directly in `directory` (repo-relative) that match `pattern`. */
function matching(directory: string, pattern: RegExp): string[] {
  const absolute = join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).filter(name => pattern.test(name)).map(name => `${directory}/${name}`);
}

describe("FSL-132: Web enterprise wiring removed", () => {
  // AC1-AC8, AC10, AC11, AC13, AC18, AC32, AC33: these exact paths are gone.
  const deletedPaths = [
    ["AC1", "apps/web/lib/enterprise-config.ts"],
    ["AC2", "apps/web/lib/enterprise-runtime.ts"],
    ["AC3", "apps/web/lib/enterprise-introspection.ts"],
    ["AC4", "apps/web/lib/enterprise-transport.ts"],
    ["AC5", "apps/web/lib/feishu-events.ts"],
    ["AC6", "apps/web/pages"],
    ["AC7", "apps/web/app/api/integrations/feishu"],
    ["AC8", "apps/web/app/api/internal/enterprise"],
    ["AC10", "apps/web/tests/contract/mega2-enterprise-session.spec.ts"],
    ["AC11", "apps/web/tests/contract/feishu-events.spec.ts"],
    ["AC13", "apps/web/tests/unit/feishu-events.test.ts"],
    ["AC18", "apps/web/tests/e2e/legacy-auth-fixture.spec.ts"],
    ["AC32", "apps/collab-server/src/enterprise-policy.integration.test.ts"],
    ["AC33", "playwright.legacy-auth.config.ts"],
  ] as const;

  it.each(deletedPaths)("%s: %s does not exist", (_ac, path) => {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  // AC9, AC12, AC14-AC17: no file of these families is left.
  const deletedFamilies = [
    ["AC9", "apps/web/tests/contract", /^enterprise-.*\.spec\.ts$/],
    ["AC12", "apps/web/tests/unit", /^enterprise-.*\.test\.ts$/],
    ["AC14", "apps/web/tests/e2e", /^enterprise-.*\.spec\.ts$/],
    ["AC15", "apps/web/tests/e2e/helpers", /^enterprise-.*\.ts$/],
    ["AC16", "apps/web/tests/e2e/catalog", /^enterprise-.*\.md$/],
    ["AC17", ".", /^playwright\.enterprise.*\.config\.ts$/],
  ] as const;

  it.each(deletedFamilies)("%s: %s holds no %s", (_ac, directory, pattern) => {
    expect(matching(directory, pattern)).toEqual([]);
  });

  // AC30: the card's zero-hit guard, run exactly as written in the card.
  const PATTERN = "enterprise-(config|runtime|introspection|transport)|feishu-events|EnterpriseLoginForm|directoryManaged|installEnterprisePairingFixture|enterprise_policy|ENTERPRISE_WEB_UNAVAILABLE";
  const guardArgs = (target: string) => ["-n", PATTERN, target, "--glob", "!**/node_modules/**", "--glob", "!**/*.tsbuildinfo",
    "--glob", "!**/.next/**", "--glob", "!**/*.test.ts", "--glob", "!**/*.spec.ts"];

  it("AC30: the rg guard over apps/web finds nothing (exit 1)", () => {
    const result = rg(guardArgs("apps/web"), ROOT);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("AC30: the same rg guard reports a planted hit (exit 0) and ignores test files (exit 1)", () => {
    const fixture = mkdtempSync(join(tmpdir(), "megaui-enterprise-removed-"));
    try {
      const web = join(fixture, "apps/web");
      mkdirSync(join(web, "lib"), { recursive: true });
      mkdirSync(join(web, "node_modules/x"), { recursive: true });
      writeFileSync(join(web, "lib/a.test.ts"), "import './enterprise-runtime'\n");
      writeFileSync(join(web, "lib/b.spec.ts"), "const directoryManaged = true\n");
      writeFileSync(join(web, "node_modules/x/index.ts"), "enterprise_policy\n");
      expect(rg(guardArgs("apps/web"), fixture).status).toBe(1);
      writeFileSync(join(web, "lib/c.ts"), "export const key = 'ENTERPRISE_WEB_UNAVAILABLE'\n");
      const hit = rg(guardArgs("apps/web"), fixture);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toContain("lib/c.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
