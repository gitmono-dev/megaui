import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SECRET_KEY_GUARD = resolve(REPO_ROOT, "scripts/check-secret-keys.sh");
const PLACEHOLDER_GUARD = resolve(REPO_ROOT, "scripts/check-env-placeholders.sh");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/ci.yml");

/**
 * The secret keys still in use (FSL-141): the Feishu app secret and the HMAC
 * key of the Feishu login. The guard owns this list, the test pins it so that
 * a key cannot silently drop out of the scans.
 */
const SECRET_KEYS = ["ENTERPRISE_OTP_HMAC_KEY", "FEISHU_APP_SECRET"];

/** The JavaScript compound assignment operators. */
const COMPOUND_OPERATORS = ["+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="];

/** A value that must never reach the guard output. */
const PLANTED_VALUE = "planted-secret-key-value";

function withFixture<T>(verify: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "megaui-secret-key-guard-"));
  try {
    return verify(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  }
}

function runSecretKeyGuard(
  options: { surfaces?: string; samples?: string; args?: string[] } = {},
): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  if (options.surfaces !== undefined) env.MEGAUI_SECRET_KEY_SURFACES = options.surfaces;
  if (options.samples !== undefined) env.MEGAUI_SECRET_KEY_SAMPLES = options.samples;
  return spawnSync("bash", [SECRET_KEY_GUARD, ...(options.args ?? [])], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("secret key guard (FSL-141)", () => {
  it("owns the single list of the two secret keys still in use", () => {
    const result = runSecretKeyGuard({ args: ["--list"] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const listed = result.stdout.split("\n").filter((line) => line.length > 0);
    expect(listed).toEqual(SECRET_KEYS);
    expect(listed).toEqual([...listed].sort());
  });

  it.each([["AC6", "FEISHU_APP_SECRET"], ["AC7", "ENTERPRISE_OTP_HMAC_KEY"]])("%s: refuses %s assigned in a production surface", (_ac, key) => {
    withFixture((dir) => {
      const surface = join(dir, "surface.ts");
      // The assignment is built at runtime so that this test file itself
      // never holds a literal secret assignment.
      writeFileSync(surface, `const value = "${key}=${PLANTED_VALUE}";\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("check-secret-keys: OK");
      expect(result.stderr).toContain(key);
      expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(SECRET_KEYS.flatMap(key => [
    `process.env.${key} = "${PLANTED_VALUE}";`,
    `const config = { ${key}: "${PLANTED_VALUE}" };`,
    `{ "${key}": "${PLANTED_VALUE}" }`,
    `${key} = '${PLANTED_VALUE}'`,
    `process.env["${key}"] = "${PLANTED_VALUE}";`,
    `process.env['${key}']='${PLANTED_VALUE}';`,
    `process.env.${key} ||= "${PLANTED_VALUE}";`,
    `process.env.${key} ??= "${PLANTED_VALUE}";`,
    `const config = { ["${key}"]: "${PLANTED_VALUE}" };`,
    ...COMPOUND_OPERATORS.map(operator => `process.env.${key} ${operator} "${PLANTED_VALUE}";`),
    ...COMPOUND_OPERATORS.map(operator => `process.env["${key}"]${operator}"${PLANTED_VALUE}";`),
  ]))("AC6/AC7: refuses the production line %j", (line) => {
    withFixture((dir) => {
      const surfaces = join(dir, "surfaces");
      mkdirSync(join(surfaces, "lib"), { recursive: true });
      writeFileSync(join(surfaces, "lib/config.ts"), `// header\n${line}\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const result = runSecretKeyGuard({ surfaces, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`lib/config\\.ts:2:(${SECRET_KEYS.join("|")})=\n`));
      expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(SECRET_KEYS.flatMap(key => [
    [key, `process.env.${key}\n  += "${PLANTED_VALUE}";`],
    [key, `const config = {\n  ${key}:\n    "${PLANTED_VALUE}",\n};`],
  ]))("AC6/AC7: refuses a production assignment of %s split across lines", (key, text) => {
    withFixture((dir) => {
      const surfaces = join(dir, "surfaces");
      mkdirSync(join(surfaces, "lib"), { recursive: true });
      writeFileSync(join(surfaces, "lib/config.ts"), `// header\n${text}\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const result = runSecretKeyGuard({ surfaces, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`lib/config\\.ts:\\d+:${key}=\n`));
      expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(SECRET_KEYS)("does not treat an unspaced comparison of %s as an assignment", (key) => {
    withFixture((dir) => {
      const surfaces = join(dir, "surfaces");
      mkdirSync(join(surfaces, "lib"), { recursive: true });
      writeFileSync(join(surfaces, "lib/check.ts"), `if (process.env.${key}===expected) {}\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const result = runSecretKeyGuard({ surfaces, samples: sample });
      expect(result.status).toBe(0);
    });
  });

  it("holds test files to the KEY= form and leaves prose alone", () => {
    withFixture((dir) => {
      const surfaces = join(dir, "surfaces");
      mkdirSync(join(surfaces, "web/tests/unit"), { recursive: true });
      mkdirSync(join(surfaces, "lib"), { recursive: true });
      const spaced = SECRET_KEYS.map(key => `process.env.${key} = "fixture"; process.env["${key}"] = "fixture"; const env = { ${key}: "fixture" };`).join("\n");
      writeFileSync(join(surfaces, "web/tests/unit/a.ts"), `${spaced}\n`);
      writeFileSync(join(surfaces, "lib/b.test.ts"), `${spaced}\n`);
      writeFileSync(join(surfaces, "lib/c.ts"), SECRET_KEYS.map(key => [
        ` * - \`${key}\`: required; read ${key} == other`,
        `if (process.env["${key}"] === other || env.${key} !== other || env.${key} == other || env.${key} != other) {}`,
        `if (env.${key} <= other || env.${key} >= other) {}`,
        `const name = "${key}"; type Source = { ${key}: string };`,
      ].join("\n")).join("\n") + "\n");
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const clean = runSecretKeyGuard({ surfaces, samples: sample });
      expect(clean.stderr).toBe("");
      expect(clean.status).toBe(0);

      writeFileSync(join(surfaces, "lib/b.test.ts"), `const line = "FEISHU_APP_SECRET=${PLANTED_VALUE}";\n`);
      const hit = runSecretKeyGuard({ surfaces, samples: sample });
      expect(hit.status).toBe(1);
      expect(hit.stderr).toContain("lib/b.test.ts:1:FEISHU_APP_SECRET=");
      expect(hit.stdout + hit.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(SECRET_KEYS)("AC8: refuses %s with a non-placeholder value in a sample file", (key) => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, `AUTH_MODE=legacy\n${key}=${PLANTED_VALUE}\n`);
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("check-secret-keys: OK");
      expect(result.stderr).toContain(key);
      expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(SECRET_KEYS)("AC8: refuses %s with a non-placeholder value in a commented-out sample line", (key) => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, `AUTH_MODE=legacy\n# ${key}=${PLANTED_VALUE}\n`);
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${sample}:2:${key}`);
      expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(SECRET_KEYS.flatMap(key => [
    ` ${key}=${PLANTED_VALUE}`,
    `export ${key}=${PLANTED_VALUE}`,
    `${key} = ${PLANTED_VALUE}`,
    `${key}="${PLANTED_VALUE}"`,
    `  #  export ${key} =${PLANTED_VALUE}`,
  ]))("AC8: refuses the sample line %j", (line) => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, `AUTH_MODE=legacy\n${line}\n`);
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`${sample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2:(${SECRET_KEYS.join("|")})\n`));
      expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it("AC8: accepts the placeholder in the same spellings", () => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, [
        " FEISHU_APP_SECRET=replace-with-feishu-app-secret",
        "export FEISHU_APP_SECRET = 'replace-with-feishu-app-secret'",
        "# ENTERPRISE_OTP_HMAC_KEY=\"REPLACE_WITH_OTP_HMAC_KEY\"",
        "",
      ].join("\n"));
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });

  it("AC9: reports only the file, the line and the key, never a value", () => {
    withFixture((dir) => {
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, SECRET_KEYS.map(key => `const ${key.toLowerCase()} = "${key}=${PLANTED_VALUE}";`).join("\n") + "\n");
      const sample = join(dir, "env.sample");
      writeFileSync(sample, SECRET_KEYS.map(key => `${key}=${PLANTED_VALUE}`).join("\n") + "\n");
      const clean = join(dir, "clean.ts");
      writeFileSync(clean, "export const value = 1;\n");

      const production = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(production.status).toBe(1);
      expect(production.stdout).toBe("");
      expect(production.stderr.trim().split("\n")).toEqual([
        "ERROR: secret keys are assigned in production surfaces:",
        ...SECRET_KEYS.map((key, index) => `${surface}:${index + 1}:${key}=`),
      ]);

      const samples = runSecretKeyGuard({ surfaces: clean, samples: sample });
      expect(samples.status).toBe(1);
      expect(samples.stdout).toBe("");
      expect(samples.stderr.trim().split("\n")).toEqual([
        "Secret keys with a non-placeholder value in sample env files:",
        ...SECRET_KEYS.map((key, index) => `${sample}:${index + 1}:${key}`),
      ]);
      expect(production.stdout + production.stderr + samples.stdout + samples.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it("does not count a longer key that ends with a secret key name", () => {
    withFixture((dir) => {
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, `const value = "LEGACY_FEISHU_APP_SECRET=${PLANTED_VALUE}";\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("check-secret-keys: OK");
    });
  });

  it("passes on the repository's production surfaces and sample files", () => {
    const result = runSecretKeyGuard();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check-secret-keys: OK");
  });

  it("fails closed when the scan tool errors", () => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");
      const missing = join(dir, "does-not-exist");

      const result = runSecretKeyGuard({ surfaces: missing, samples: sample });
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(1);
      expect(result.stderr).toContain("secret key scan failed");
    });
  });

  it("fails closed when a directory below a surface cannot be read", () => {
    // Root can read any directory, so the case cannot be built there.
    if (process.getuid?.() === 0) return;
    withFixture((dir) => {
      const surfaces = join(dir, "surfaces");
      const locked = join(surfaces, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "surface.ts"), `const value = "FEISHU_APP_SECRET=${PLANTED_VALUE}";\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");
      chmodSync(locked, 0o000);
      try {
        const result = runSecretKeyGuard({ surfaces, samples: sample });
        expect(result.status).toBe(2);
        expect(result.stdout).not.toContain("check-secret-keys: OK");
        expect(result.stderr).toContain("secret key scan failed");
        expect(result.stdout + result.stderr).not.toContain(PLANTED_VALUE);
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  });

  it("fails closed when a sample file is missing", () => {
    withFixture((dir) => {
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");
      const missing = join(dir, "does-not-exist");

      const result = runSecretKeyGuard({ surfaces: surface, samples: missing });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing sample env file");
    });
  });

  it("does not report a clean schema", () => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(
        sample,
        [
          "# a normal sample",
          "APP_BASE_URL=http://127.0.0.1:3000",
          "AUTH_MODE=legacy",
          "FEISHU_APP_SECRET=replace-with-feishu-app-secret",
          "ENTERPRISE_OTP_HMAC_KEY=REPLACE_WITH_OTP_HMAC_KEY",
          "",
        ].join("\n"),
      );
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runSecretKeyGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("check-secret-keys: OK");
    });
  });

  it("needs no external search tool", () => {
    withFixture((dir) => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // A search tool that is missing must not change the guard's result:
      // CI runs the unit tests before it installs ripgrep.
      writeFileSync(
        join(bin, "rg"),
        '#!/usr/bin/env bash\necho "rg: command not found" >&2\nexit 127\n',
        { mode: 0o700 },
      );
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = spawnSync("bash", [SECRET_KEY_GUARD], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          MEGAUI_SECRET_KEY_SURFACES: surface,
          MEGAUI_SECRET_KEY_SAMPLES: sample,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("check-secret-keys: OK");
    });
  });

  it("keeps the checked value out of the placeholder guard output", () => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, `BETTER_AUTH_SECRET=${PLANTED_VALUE}\n`);

      const result = spawnSync("bash", [PLACEHOLDER_GUARD, sample], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("BETTER_AUTH_SECRET");
      expect(result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it("runs in the CI workflow", () => {
    const workflow = readFileSync(CI_WORKFLOW, "utf8");
    expect(workflow).toContain("run: bash scripts/check-secret-keys.sh");
  });
});
