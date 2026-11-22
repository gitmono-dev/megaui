// megaui-only: zero-hit guards of the Phase 2 enterprise removal cards (plan-20261118).
//
// Each removal card owns one section below and later cards append their own. A section
// asserts that every path its card deletes is absent and runs the card's `rg` guard as a
// child process: exit 1 (no match) passes, exit 0 (a match) or >1 (an error) fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("FSL-133: the @megaui/auth enterprise plugin removed", () => {
  // AC3: the directory and every file it held are gone.
  const deletedPaths = [
    "packages/auth/src/enterprise-otp",
    ...["code", "consume", "crypto", "input", "plugin", "policy", "public-session-client", "public-session", "request",
      "status", "types", "verify"].map(name => `packages/auth/src/enterprise-otp/${name}.ts`),
    ...["code", "input", "plugin", "request"].map(name => `packages/auth/src/enterprise-otp/${name}.test.ts`),
    ...["consume", "verify"].map(name => `packages/auth/src/enterprise-otp/${name}.integration.test.ts`),
  ];

  it.each(deletedPaths.map(path => ["AC3", path] as const))("%s: %s does not exist", (_ac, path) => {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  it("AC1: the code generator lives in packages/auth/src/feishu-login/code.ts", () => {
    expect(existsSync(join(ROOT, "packages/auth/src/feishu-login/code.ts"))).toBe(true);
  });

  // AC11: the card's zero-hit guard, run exactly as written in the card.
  const PATTERN = "enterprise-otp|enterprisePairing|enterpriseSession|enterpriseOperationPolicy";
  const guardArgs = ["-n", PATTERN, "packages/auth/src", "apps", "--glob", "!**/node_modules/**", "--glob", "!**/.next/**",
    "--glob", "!**/*.tsbuildinfo", "--glob", "!**/*.test.ts", "--glob", "!**/*.spec.ts", "--glob", "!**/tests/**"];

  it("AC11: the rg guard over packages/auth/src and apps finds nothing (exit 1)", () => {
    const result = rg(guardArgs, ROOT);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("AC11: the same rg guard reports a planted hit (exit 0) and ignores tests (exit 1)", () => {
    const fixture = mkdtempSync(join(tmpdir(), "megaui-enterprise-removed-"));
    try {
      const auth = join(fixture, "packages/auth/src");
      const web = join(fixture, "apps/web");
      mkdirSync(join(auth, "feishu-login"), { recursive: true });
      mkdirSync(join(web, "tests/unit"), { recursive: true });
      mkdirSync(join(web, "node_modules/x"), { recursive: true });
      writeFileSync(join(auth, "feishu-login/a.test.ts"), "import './enterprise-otp/code'\n");
      writeFileSync(join(web, "tests/unit/b.ts"), "const enterprisePairing = true\n");
      writeFileSync(join(web, "node_modules/x/index.ts"), "enterpriseSession\n");
      expect(rg(guardArgs, fixture).status).toBe(1);
      writeFileSync(join(auth, "c.ts"), "export const enterpriseOperationPolicy = 1\n");
      const hit = rg(guardArgs, fixture);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toContain("packages/auth/src/c.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("FSL-134: collab enterprise metadata removed", () => {
  // AC1, AC2 and the card's other deletions: these exact paths are gone.
  const deletedPaths = [
    ["AC1", "apps/collab-server/src/enterprise-policy.ts"],
    ["AC2", "apps/collab-server/src/enterprise-revalidation.ts"],
    ["write set", "apps/collab-server/src/enterprise-revoke.integration.test.ts"],
    ["write set", "apps/collab-server/src/enterprise-ticket.test.ts"],
  ] as const;

  it.each(deletedPaths)("%s: %s does not exist", (_ac, path) => {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  // AC10: the card's zero-hit guard, run exactly as written in the card.
  const PATTERN = "enterprise-policy|enterprise-revalidation|ENTERPRISE_COLLAB_REVOKE_KEY|authEpoch|identityId|/internal/revoke";
  const TARGETS = ["apps/collab-server/src", "packages/core/src/collab", "packages/engine/src/services/collab",
    "apps/web/lib/adapter/handlers/collab-token.ts"];
  const guardArgs = ["-n", PATTERN, ...TARGETS, "--glob", "!**/*.test.ts", "--glob", "!**/*.spec.ts", "--glob", "!**/tests/**"];

  it("AC10: the rg guard over the collab link finds nothing (exit 1)", () => {
    const result = rg(guardArgs, ROOT);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("AC10: the same rg guard reports a planted hit (exit 0) and ignores tests (exit 1)", () => {
    const fixture = mkdtempSync(join(tmpdir(), "megaui-enterprise-removed-"));
    try {
      const collab = join(fixture, "apps/collab-server/src");
      mkdirSync(collab, { recursive: true });
      mkdirSync(join(fixture, "packages/core/src/collab/tests"), { recursive: true });
      mkdirSync(join(fixture, "packages/engine/src/services/collab"), { recursive: true });
      mkdirSync(join(fixture, "apps/web/lib/adapter/handlers"), { recursive: true });
      writeFileSync(join(fixture, "apps/web/lib/adapter/handlers/collab-token.ts"), "export const ok = true\n");
      writeFileSync(join(collab, "internal-api.test.ts"), "expect('/internal/revoke').toBeTruthy()\n");
      writeFileSync(join(fixture, "packages/core/src/collab/ticket.spec.ts"), "const authEpoch = 1\n");
      writeFileSync(join(fixture, "packages/core/src/collab/tests/a.ts"), "const identityId = 'x'\n");
      expect(rg(guardArgs, fixture).status).toBe(1);
      writeFileSync(join(fixture, "packages/engine/src/services/collab/token.ts"), "export const identityId = 'x'\n");
      const hit = rg(guardArgs, fixture);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toContain("packages/engine/src/services/collab/token.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("FSL-137: engine enterprise services, worker and admin CLI removed", () => {
  // AC5-AC7 and the card's other deletions: these exact paths are gone.
  const deletedPaths = [
    ["AC5", "packages/engine/src/services/enterprise"],
    ["AC6", "packages/engine/src/workers/enterprise.ts"],
    ["AC6", "packages/engine/src/workers/enterprise-config.ts"],
    ["AC6", "packages/engine/src/workers/enterprise-pairing.ts"],
    ["AC6", "packages/engine/src/workers/enterprise-pairing.test.ts"],
    ["AC6", "packages/engine/src/workers/enterprise-runtime.test.ts"],
    ["AC7", "packages/engine/src/cli"],
    ["write set", "tests/guards/admin-write-verbs.test.ts"],
    ["write set", "packages/email/src/templates/enterprise-login.ts"],
    ["write set", "packages/email/src/templates/enterprise-login.test.ts"],
  ] as const;

  it.each(deletedPaths)("%s: %s does not exist", (_ac, path) => {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  it("AC6: packages/engine/src/workers holds no enterprise*.ts", () => {
    expect(matching("packages/engine/src/workers", /^enterprise.*\.ts$/)).toEqual([]);
  });

  it("AC1, AC3: the Feishu client and the public profile module live at their new paths", () => {
    for (const name of ["http", "token", "message", "types", "contact"]) {
      expect(existsSync(join(ROOT, `packages/engine/src/services/feishu/${name}.ts`)), name).toBe(true);
    }
    expect(existsSync(join(ROOT, "packages/engine/src/services/public-profile.ts"))).toBe(true);
  });

  // AC13: the card's zero-hit guard, run exactly as written in the card.
  const PATTERN = "services/enterprise|sendEnterpriseLoginNotificationEmail|workers/enterprise|cli/(admin-|enterprise-admin)|enterprise:(worker|admin|approve)";
  const TARGETS = ["packages", "apps", "scripts", "tests", "package.json"];
  const guardArgs = ["-n", PATTERN, ...TARGETS, "--glob", "!**/node_modules/**", "--glob", "!**/*.tsbuildinfo",
    "--glob", "!**/.next/**", "--glob", "!**/*.test.ts", "--glob", "!**/*.spec.ts", "--glob", "!**/tests/**"];

  it("AC13: the rg guard over packages, apps, scripts, tests and package.json finds nothing (exit 1)", () => {
    const result = rg(guardArgs, ROOT);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("AC13: the same rg guard reports a planted hit (exit 0) and ignores tests (exit 1)", () => {
    const fixture = mkdtempSync(join(tmpdir(), "megaui-enterprise-removed-"));
    try {
      for (const directory of ["packages/engine/src/services", "apps/web/lib", "scripts", "tests/guards",
        "packages/engine/node_modules/x"]) {
        mkdirSync(join(fixture, directory), { recursive: true });
      }
      writeFileSync(join(fixture, "package.json"), "{\"scripts\": {\"seed\": \"tsx ./src/seed.ts\"}}\n");
      writeFileSync(join(fixture, "packages/engine/src/services/a.test.ts"), "import './enterprise/events'\n");
      writeFileSync(join(fixture, "apps/web/lib/b.spec.ts"), "sender.sendEnterpriseLoginNotificationEmail()\n");
      writeFileSync(join(fixture, "tests/guards/c.ts"), "const path = 'src/workers/enterprise.ts'\n");
      writeFileSync(join(fixture, "packages/engine/node_modules/x/index.ts"), "import './cli/admin-env'\n");
      expect(rg(guardArgs, fixture).status).toBe(1);
      writeFileSync(join(fixture, "scripts/run.sh"), "pnpm --filter @megaui/engine run enterprise:worker\n");
      const hit = rg(guardArgs, fixture);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toContain("scripts/run.sh");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("FSL-138: core enterprise module removed", () => {
  // AC3 and the card's other deletions: these exact paths are gone.
  const deletedPaths = [
    ["AC3", "packages/core/src/enterprise"],
    ...["config", "config.test", "eligibility", "eligibility.test", "policy", "provider-admission",
      "provider-admission.test"].map(name => ["AC3", `packages/core/src/enterprise/${name}.ts`] as const),
  ] as const;

  it.each(deletedPaths)("%s: %s does not exist", (_ac, path) => {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  it("AC1: the provider admission and its test live in packages/core/src/feishu", () => {
    expect(existsSync(join(ROOT, "packages/core/src/feishu/provider-admission.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "packages/core/src/feishu/provider-admission.test.ts"))).toBe(true);
  });

  // AC4: the barrel no longer re-exports an enterprise module, and none of the removed
  // enterprise API is reachable from the @megaui/core entry (`packages/core/src/index.ts`,
  // its package.json "." export); the provider admission still is.
  it("AC4: @megaui/core exports no enterprise API", async () => {
    const barrel = readFileSync(join(ROOT, "packages/core/src/index.ts"), "utf8");
    expect(barrel).not.toMatch(/\.\/enterprise\//);
    expect(barrel).toContain("export * from './feishu/provider-admission'");
    const core: Record<string, unknown> = await import("../../packages/core/src/index");
    const removed = ["AUTH_MODES", "DEFAULT_AUTH_MODE", "EnterpriseConfigError", "parseDirectoryDepartmentIds",
      "resolveEnterpriseConfig", "resolveEffectiveAuthMode", "isActiveLocalBan", "isAuthenticationEligible",
      "ENTERPRISE_POLICY_SCHEMA_VERSION", "createEnterprisePolicyResponse", "parseEnterprisePolicyResponse",
      "CLIENT_SAFE_KEYS", "isClientSafeKey", "findClientUnsafeKeys"];
    for (const name of removed) expect(core, name).not.toHaveProperty(name);
    expect(Object.keys(core).filter(name => /enterprise/i.test(name))).toEqual([]);
    for (const name of ["admitProvider", "ProviderAdmissionError", "OFFICIAL_FEISHU_ORIGIN", "resolveAuthMode"]) {
      expect(core, name).toHaveProperty(name);
    }
  });

  // AC7: the card's zero-hit guard, run exactly as written in the card.
  const PATTERN = "core/src/enterprise|resolveEnterpriseConfig|isAuthenticationEligible";
  const guardArgs = ["-n", PATTERN, "packages", "apps", "--glob", "!**/node_modules/**", "--glob", "!**/*.tsbuildinfo",
    "--glob", "!**/.next/**", "--glob", "!**/*.test.ts", "--glob", "!**/*.spec.ts", "--glob", "!**/tests/**"];

  it("AC7: the rg guard over packages and apps finds nothing (exit 1)", () => {
    const result = rg(guardArgs, ROOT);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("AC7: the same rg guard reports a planted hit (exit 0) and ignores tests (exit 1)", () => {
    const fixture = mkdtempSync(join(tmpdir(), "megaui-enterprise-removed-"));
    try {
      for (const directory of ["packages/core/src", "apps/web/lib", "apps/web/tests/unit", "packages/core/node_modules/x"]) {
        mkdirSync(join(fixture, directory), { recursive: true });
      }
      writeFileSync(join(fixture, "packages/core/src/a.test.ts"), "import './enterprise/config'\nresolveEnterpriseConfig()\n");
      writeFileSync(join(fixture, "apps/web/lib/b.spec.ts"), "isAuthenticationEligible(facts)\n");
      writeFileSync(join(fixture, "apps/web/tests/unit/c.ts"), "const path = 'packages/core/src/enterprise/policy.ts'\n");
      writeFileSync(join(fixture, "packages/core/node_modules/x/index.ts"), "resolveEnterpriseConfig\n");
      writeFileSync(join(fixture, "apps/web/tsconfig.tsbuildinfo"), "packages/core/src/enterprise/config.ts\n");
      expect(rg(guardArgs, fixture).status).toBe(1);
      writeFileSync(join(fixture, "apps/web/lib/d.ts"), "export { isAuthenticationEligible } from '@megaui/core'\n");
      const hit = rg(guardArgs, fixture);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toContain("apps/web/lib/d.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("FSL-139: database enterprise code removed", () => {
  const STORES = ["actor", "directory", "grant", "identity", "offboarding", "operations", "policy", "repair"];

  // AC1-AC3 and the card's other deletions: these exact paths are gone.
  const deletedPaths = [
    ...STORES.map(name => ["AC1", `packages/database/src/enterprise-${name}-store.ts`] as const),
    ["AC2", "packages/database/src/enterprise-scope.ts"],
    ["AC3", "packages/database/src/enterprise-scope-cli.ts"],
    ["write set", "packages/database/src/enterprise-scope.test.ts"],
  ] as const;

  it.each(deletedPaths)("%s: %s does not exist", (_ac, path) => {
    expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  // AC1: no enterprise-*.ts is left directly in packages/database/src (the schema files
  // under schema/auth/ stay until FSL-168).
  it("AC1: packages/database/src holds no enterprise-*.ts", () => {
    expect(matching("packages/database/src", /^enterprise-.*\.ts$/)).toEqual([]);
  });

  // AC6: db:migrate runs drizzle-kit migrate and nothing else.
  it("AC6: db:migrate is exactly drizzle-kit migrate", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages/database/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.["db:migrate"]).toBe("drizzle-kit migrate");
  });

  // AC9: the card's zero-hit guard, run exactly as written in the card.
  const PATTERN = "createEnterpriseDatabaseClient|enterprise-scope|enterprise-grant-store|enterprise_profile";
  const TARGETS = ["packages/database/src", "apps", "packages/auth", "packages/engine"];
  const guardArgs = ["-n", PATTERN, ...TARGETS, "--glob", "!**/node_modules/**", "--glob", "!**/*.tsbuildinfo",
    "--glob", "!**/.next/**", "--glob", "!**/schema/auth/**", "--glob", "!**/drizzle/**", "--glob", "!**/*.test.ts",
    "--glob", "!**/*.spec.ts"];

  it("AC9: the rg guard over the database code, apps, auth and engine finds nothing (exit 1)", () => {
    const result = rg(guardArgs, ROOT);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("AC9: the same rg guard reports a planted hit (exit 0) and ignores schema, migrations and tests (exit 1)", () => {
    const fixture = mkdtempSync(join(tmpdir(), "megaui-enterprise-removed-"));
    try {
      for (const directory of ["packages/database/src/schema/auth", "packages/database/drizzle", "packages/auth/src",
        "packages/engine/src", "apps/web/lib", "apps/web/.next", "packages/engine/node_modules/x"]) {
        mkdirSync(join(fixture, directory), { recursive: true });
      }
      writeFileSync(join(fixture, "packages/database/src/schema/auth/enterprise-profile.ts"),
        "export const t = pgTable('enterprise_profile', {})\n");
      writeFileSync(join(fixture, "packages/database/drizzle/0004_x.sql"), "CREATE TABLE \"enterprise_profile\" ();\n");
      writeFileSync(join(fixture, "packages/database/src/migrate.test.ts"), "select 1 from enterprise_profile\n");
      writeFileSync(join(fixture, "apps/web/lib/a.spec.ts"), "createEnterpriseDatabaseClient()\n");
      writeFileSync(join(fixture, "apps/web/.next/b.js"), "require('./enterprise-scope')\n");
      writeFileSync(join(fixture, "apps/web/tsconfig.tsbuildinfo"), "packages/database/src/enterprise-grant-store.ts\n");
      writeFileSync(join(fixture, "packages/engine/node_modules/x/index.ts"), "enterprise_profile\n");
      expect(rg(guardArgs, fixture).status).toBe(1);
      writeFileSync(join(fixture, "apps/web/lib/c.ts"), "await pool.query('select 1 from enterprise_profile')\n");
      const hit = rg(guardArgs, fixture);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toContain("apps/web/lib/c.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
