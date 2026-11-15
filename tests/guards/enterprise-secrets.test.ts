import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const ENTERPRISE_SECRET_GUARD = resolve(REPO_ROOT, "scripts/check-enterprise-secrets.sh");
const PLACEHOLDER_GUARD = resolve(REPO_ROOT, "scripts/check-env-placeholders.sh");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/ci.yml");

/**
 * The enterprise secret keys of ADR-FS-ENT-07. The guard owns this list, the
 * test pins it so that a key cannot silently drop out of the scans.
 */
const ENTERPRISE_SECRET_KEYS = [
  "ENTERPRISE_CANARY_SIGNING_PRIVATE_KEY",
  "ENTERPRISE_COLLAB_REVOKE_KEY",
  "ENTERPRISE_DELIVERY_KEY",
  "ENTERPRISE_INTROSPECTION_KEY",
  "ENTERPRISE_IP_HMAC_MASTER_KEY",
  "ENTERPRISE_LIVE_RESULTS_PRIVATE_KEY",
  "ENTERPRISE_OTP_HMAC_KEY",
  "ENTERPRISE_PROBE_SIGNING_PRIVATE_KEY",
  "FEISHU_APP_SECRET",
  "FEISHU_EVENT_ENCRYPT_KEY",
  "FEISHU_EVENT_VERIFICATION_TOKEN",
];

/** A value that must never reach the guard output. */
const PLANTED_VALUE = "planted-enterprise-secret-value";

function withFixture<T>(verify: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "megaui-enterprise-secret-guard-"));
  try {
    return verify(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  }
}

function runEnterpriseGuard(
  options: { surfaces?: string; samples?: string; args?: string[] } = {},
): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  if (options.surfaces !== undefined) env.MEGAUI_ENTERPRISE_SURFACES = options.surfaces;
  if (options.samples !== undefined) env.MEGAUI_ENTERPRISE_SAMPLES = options.samples;
  return spawnSync("bash", [ENTERPRISE_SECRET_GUARD, ...(options.args ?? [])], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("enterprise secret guard (FS-51)", () => {
  it("owns the single list of enterprise secret keys", () => {
    const result = runEnterpriseGuard({ args: ["--list"] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const listed = result.stdout.split("\n").filter((line) => line.length > 0);
    expect(listed).toEqual(ENTERPRISE_SECRET_KEYS);
    expect(listed).toEqual([...listed].sort());
  });

  it.each(ENTERPRISE_SECRET_KEYS)("refuses %s in a production surface", (key) => {
    withFixture((dir) => {
      const surface = join(dir, "surface.ts");
      // The assignment is built at runtime so that this test file itself
      // never holds a literal secret assignment.
      writeFileSync(surface, `const value = "${key}=${PLANTED_VALUE}";\n`);
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");

      const result = runEnterpriseGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("check-enterprise-secrets: OK");
      expect(result.stderr).toContain(key);
      expect(result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it.each(ENTERPRISE_SECRET_KEYS)("refuses %s with a material value in a sample file", (key) => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, `AUTH_MODE=legacy\n${key}=${PLANTED_VALUE}\n`);
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runEnterpriseGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("check-enterprise-secrets: OK");
      expect(result.stderr).toContain(key);
      expect(result.stderr).not.toContain(PLANTED_VALUE);
    });
  });

  it("fails closed when the scan tool errors", () => {
    withFixture((dir) => {
      const sample = join(dir, "env.sample");
      writeFileSync(sample, "AUTH_MODE=legacy\n");
      const missing = join(dir, "does-not-exist");

      const result = runEnterpriseGuard({ surfaces: missing, samples: sample });
      expect(result.status).not.toBe(0);
      expect(result.status).not.toBe(1);
      expect(result.stderr).toContain("enterprise secret scan failed");
    });
  });

  it("fails closed when a sample file is missing", () => {
    withFixture((dir) => {
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");
      const missing = join(dir, "does-not-exist");

      const result = runEnterpriseGuard({ surfaces: surface, samples: missing });
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
          "FEISHU_APP_SECRET=replace-with-enterprise-app-secret",
          "ENTERPRISE_OTP_HMAC_KEY=REPLACE_WITH_ENTERPRISE_OTP_HMAC_KEY",
          "",
        ].join("\n"),
      );
      const surface = join(dir, "surface.ts");
      writeFileSync(surface, "export const value = 1;\n");

      const result = runEnterpriseGuard({ surfaces: surface, samples: sample });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("check-enterprise-secrets: OK");
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

      const result = spawnSync("bash", [ENTERPRISE_SECRET_GUARD], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          MEGAUI_ENTERPRISE_SURFACES: surface,
          MEGAUI_ENTERPRISE_SAMPLES: sample,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("check-enterprise-secrets: OK");
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
    expect(workflow).toContain("scripts/check-enterprise-secrets.sh");
  });
});
