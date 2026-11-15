import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * FSM-21：Mock workspace 工具链的真实行为断言。
 * 只读本卡产物与 workspace/lockfile，不启动任何长驻服务。
 */
const APP_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackage(): PackageManifest {
  return JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8")) as PackageManifest;
}

/** The files `pnpm typecheck` would actually check for this app. */
function typecheckedFiles(): string[] {
  const configPath = resolve(APP_ROOT, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, APP_ROOT);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }
  return parsed.fileNames.map((file) => relative(APP_ROOT, file));
}

/** Runs the dev script with a stubbed tsx and returns the arguments it received. */
function runDevScriptWithStubbedTsx(): string[] {
  const stubDir = mkdtempSync(join(tmpdir(), "megaui-feishu-mock-dev-"));
  const recordFile = join(stubDir, "argv.txt");
  try {
    const stub = join(stubDir, "tsx");
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(recordFile)}\n`);
    chmodSync(stub, 0o755);
    const script = readPackage().scripts?.dev;
    if (!script) throw new Error("dev script is missing");
    const result = spawnSync("sh", ["-c", script], {
      cwd: APP_ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(recordFile)).toBe(true);
    return readFileSync(recordFile, "utf8").split("\n").filter(Boolean);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    expect(existsSync(stubDir)).toBe(false);
  }
}

describe("feishu-mock workspace toolchain (FSM-21)", () => {
  it("is a private workspace package named @megaui/feishu-mock", () => {
    const manifest = readPackage();
    expect(manifest.name).toBe("@megaui/feishu-mock");
    expect(manifest.private).toBe(true);
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.type).toBe("module");
  });

  it("requires Node 24 or newer", () => {
    expect(readPackage().engines?.node).toBe(">=24");
  });

  it("is discovered by the workspace", () => {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@megaui/feishu-mock", "exec", "pwd"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(APP_ROOT);
  });

  it("installs no third-party dependency", () => {
    // The manifest declares nothing; the packages pnpm reports as unsaved
    // come from the shared root toolchain, not from this app's importer.
    const manifest = readPackage();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      expect(Object.keys(manifest[field] ?? {}), field).toEqual([]);
    }
    const result = spawnSync(
      "pnpm",
      ["--filter", "@megaui/feishu-mock", "list", "--depth", "0", "--json"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const projects = JSON.parse(result.stdout) as {
      name?: string;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    }[];
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe("@megaui/feishu-mock");
    expect(Object.keys(projects[0]?.dependencies ?? {})).toEqual([]);
    expect(Object.keys(projects[0]?.devDependencies ?? {})).toEqual([]);
  });

  it("records an empty workspace importer in the lockfile", () => {
    const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toMatch(/^ {2}apps\/feishu-mock: \{\}$/m);
  });

  it("typechecks both src and tests", () => {
    const files = typecheckedFiles();
    expect(files).toContain(join("src", "index.ts"));
    expect(files).toContain(join("tests", "unit", "toolchain.test.ts"));
  });

  it("runs this app's entry through the existing tsx in the dev script", () => {
    // The stub only runs when the dev script invokes the workspace's tsx,
    // and the recorded arguments show which entry it was pointed at.
    const argv = runDevScriptWithStubbedTsx();
    expect(argv).toContain("src/index.ts");
    expect(argv).toContain("--tsconfig");
  });

  it("declares typecheck, build and lint scripts that run the existing toolchain", () => {
    const scripts = readPackage().scripts ?? {};
    expect(scripts.typecheck).toBe("tsc --noEmit");
    expect(scripts.build).toBe("tsc --noEmit");
    expect(scripts.lint).toBe("eslint .");
  });
});
