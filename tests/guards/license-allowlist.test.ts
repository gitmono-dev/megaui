import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GUARD = resolve(__dirname, "../../scripts/check-licenses.sh");

function withLicenseReport(
  name: string,
  license: string,
  verify: (result: ReturnType<typeof spawnSync>) => void,
): void {
  const fixtureDir = mkdtempSync(join(tmpdir(), "megaui-license-guard-"));
  try {
    const report = join(fixtureDir, "licenses.json");
    writeFileSync(report, JSON.stringify({ [license]: [{ name }] }));
    writeFileSync(
      join(fixtureDir, "pnpm"),
      [
        "#!/usr/bin/env bash",
        '[[ "$*" == "licenses list --json" ]] || exit 97',
        'cat "$LICENSE_FIXTURE_FILE"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [GUARD], {
      env: {
        PATH: `${fixtureDir}${delimiter}${process.env.PATH ?? ""}`,
        LICENSE_FIXTURE_FILE: report,
        TMPDIR: fixtureDir,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    verify(result);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    expect(existsSync(fixtureDir)).toBe(false);
  }
}

describe("license allowlist guard (FIX-FSM-01)", () => {
  it.each([
    ["fixture-permissive", "MIT"],
    ["@img/sharp-libvips-darwin-arm64", "LGPL-3.0-or-later"],
    ["@img/sharp-libvips-linux-arm64", "LGPL-3.0-or-later"],
    ["@img/sharp-libvips-linuxmusl-arm64", "LGPL-3.0-or-later"],
    ["@img/sharp-libvips-linux-x64", "LGPL-3.0-or-later"],
    ["@img/sharp-libvips-linuxmusl-x64", "LGPL-3.0-or-later"],
  ])("allows %s with %s", (name, license) => {
    withLicenseReport(name, license, (result) => {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("check-licenses: OK");
      expect(result.stderr).toBe("");
    });
  });

  it.each([
    ["fixture-other-lgpl", "LGPL-3.0-or-later"],
    ["fixture-gpl", "GPL-3.0-only"],
  ])("rejects unlisted %s with %s", (name, license) => {
    withLicenseReport(name, license, (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("check-licenses: disallowed licenses:");
      expect(result.stderr).toContain(`${name}: ${license}`);
      expect(result.stdout).not.toContain("check-licenses: OK");
    });
  });
});
