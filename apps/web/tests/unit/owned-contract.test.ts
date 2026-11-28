// megaui-only (FIX-FS-02): actual databases, mint process and cleanup ownership.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseClient, getPool } from "@megaui/database";
import { createIsolatedPostgres } from "@megaui/database/test-support";
import * as postgres from "@megaui/database/test-support";
import { describe, expect, it, vi } from "vitest";
import { getAuth } from "@/lib/auth";
import { ownedContractFixture } from "../helpers/owned-contract";
import { copyOwnedSource, OwnedWeb, readOwnedCommandDiagnostics, withOwnedWeb } from "../helpers/owned-web";

type Resources = NonNullable<ReturnType<ReturnType<typeof ownedContractFixture>["resources"]>>;
async function removed(resources: Resources) {
  await expect(access(resources.directory)).rejects.toThrow();
  const runId = resources.databaseName.slice("megaui_test_".length);
  const containers = execFileSync("docker", ["ps", "-a", "--filter", `label=megaui-run-id=${runId}`, "--format", "{{.Names}}"], { encoding: "utf8" });
  expect(containers.trim()).toBe("");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function cleanupOwnedPaths(paths: readonly (string | undefined)[]): Promise<void> {
  const roots = paths.filter((value): value is string => value !== undefined);
  const unlock = async (root: string): Promise<void> => {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(path.join(root, entry.name));
    }
  };
  const unlockResults = await Promise.allSettled(roots.map(unlock));
  const results = await Promise.allSettled(roots
    .map(value => rm(value, { recursive: true, force: true })));
  const failures = [...unlockResults, ...results].filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Synthetic owned-tree cleanup failed");
}

async function manifest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) result[relative] = `link:${await readlink(target)}`;
      else if (entry.isDirectory()) {
        result[relative] = `dir:${(await stat(target)).mode & 0o7777}`;
        await visit(target);
      } else if (entry.isFile()) {
        result[relative] = `file:${(await stat(target)).mode & 0o7777}:${await readFile(target, "base64")}`;
      }
    }
  };
  await visit(root);
  return result;
}

const ORACLE_OUTPUT_DIRS = new Set([".git", ".libra", ".turbo", ".next", ".pnpm-store", ".cache", ".vite", "coverage", "dist", "test-results", "playwright-report"]);
const ORACLE_NODE_MODULES_EXCLUDED = new Set([".cache", ".vite", ".tmp"]);
function oracleIncludes(sourceRoot: string, source: string): boolean {
  const relative = path.relative(sourceRoot, source);
  const parts = relative ? relative.split(path.sep) : [];
  const name = path.basename(source);
  if ((name.startsWith(".env") && name !== ".env.example" && name !== ".env.test.example") || name.endsWith(".tsbuildinfo")) return false;
  if (!parts.includes("node_modules") && ORACLE_OUTPUT_DIRS.has(name)) return false;
  return !(parts.includes("node_modules") && ORACLE_NODE_MODULES_EXCLUDED.has(name));
}

type OracleEntry = `dir:${number}` | `link:${string}` | `file:${number}:${string}` | `forbidden:${string}`;

// Walk multiple directories at once without opening an unbounded number of files.
// The installed pnpm tree has hundreds of thousands of entries on CI.
async function walkOracleDirectories(root: string, visit: (directory: string) => Promise<string[]>): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const batch = pending.splice(0, 32);
    const results = await Promise.allSettled(batch.map(visit));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Oracle walk failed");
    for (const result of results) if (result.status === "fulfilled") pending.push(...result.value);
  }
}

async function sourceOracleManifest(root: string, destinationRoot: string): Promise<Record<string, OracleEntry>> {
  const result: Record<string, OracleEntry> = {};
  const originalRoots = [root, await realpath(root)];
  await walkOracleDirectories(root, async directory => {
    const children: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (!oracleIncludes(root, target)) continue;
      const relative = path.relative(root, target);
      const metadata = await lstat(target);
      if (entry.isSymbolicLink()) result[relative] = `link:${await readlink(target)}`;
      else if (entry.isDirectory()) {
        result[relative] = `dir:${metadata.mode & 0o7777}`;
        children.push(target);
      } else if (entry.isFile()) {
        const bytes = await readFile(target);
        let comparable = bytes;
        if (relative.split(path.sep).includes(".bin")) {
          let text = bytes.toString("utf8");
          for (const rootPath of originalRoots) text = text.replaceAll(rootPath, destinationRoot);
          comparable = Buffer.from(text);
        }
        result[relative] = `file:${metadata.mode & 0o7777}:${createHash("sha256").update(comparable).digest("hex")}`;
      } else throw new Error(`Oracle encountered unsupported source entry: ${relative}`);
    }
    return children;
  });
  return result;
}

async function candidateOracleManifest(root: string): Promise<Record<string, OracleEntry>> {
  const result: Record<string, OracleEntry> = {};
  await walkOracleDirectories(root, async directory => {
    const children: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      const metadata = await lstat(target);
      if (!oracleIncludes(root, target)) {
        result[relative] = `forbidden:${entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file"}`;
        continue;
      }
      if (entry.isSymbolicLink()) result[relative] = `link:${await readlink(target)}`;
      else if (entry.isDirectory()) {
        result[relative] = `dir:${metadata.mode & 0o7777}`;
        children.push(target);
      } else if (entry.isFile()) {
        const bytes = await readFile(target);
        result[relative] = `file:${metadata.mode & 0o7777}:${createHash("sha256").update(bytes).digest("hex")}`;
      } else throw new Error(`Oracle encountered unsupported candidate entry: ${relative}`);
    }
    return children;
  });
  return result;
}

function oracleDifferences(expected: Record<string, OracleEntry>, actual: Record<string, OracleEntry>): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].sort().flatMap(key => expected[key] === actual[key] ? [] : [`${key}: expected=${expected[key] ?? "<missing>"} actual=${actual[key] ?? "<missing>"}`]);
}

describe("owned legacy BFF contracts", () => {
  it("copies the complete filtered tree privately with bounded workers and validates link boundaries", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "megaui-copy-source-"));
    const parentOne = await mkdtemp(path.join(tmpdir(), "megaui-copy-dest-"));
    const parentTwo = await mkdtemp(path.join(tmpdir(), "megaui-copy-dest-"));
    const destinationOne = path.join(parentOne, "source");
    const destinationTwo = path.join(parentTwo, "source");
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    let active = 0;
    let peak = 0;
    let outside: string | undefined;
    try {
      await mkdir(path.join(source, "apps/web/node_modules/@megaui"), { recursive: true });
      await mkdir(path.join(source, "packages/core"), { recursive: true });
      await mkdir(path.join(source, "node_modules/pkg/dist"), { recursive: true });
      await mkdir(path.join(source, "node_modules/pkg/.tmp"), { recursive: true });
      await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
      await mkdir(path.join(source, "dist"), { recursive: true });
      await mkdir(path.join(source, "node_modules/.pnpm/pkg@1/node_modules/pkg"), { recursive: true });
      await chmod(path.join(source, "node_modules/.pnpm"), 0o751);
      await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(path.join(source, `root-${index}.txt`), `root-${index}`)));
      await writeFile(path.join(source, "apps/web/.env.example"), "allowed");
      await writeFile(path.join(source, "apps/web/.env.test.example"), "allowed");
      await writeFile(path.join(source, "apps/web/.env.local"), "secret");
      await writeFile(path.join(source, "node_modules/pkg/.env"), "secret");
      await writeFile(path.join(source, "node_modules/pkg/dist/kept.js"), "kept");
      await writeFile(path.join(source, "packages/core/index.ts"), "source");
      await writeFile(path.join(source, "node_modules/pkg/.tmp/removed.js"), "removed");
      await writeFile(path.join(source, "node_modules/.pnpm/pkg@1/node_modules/pkg/index.js"), "package");
      await writeFile(path.join(source, "node_modules/.bin/tool"), `#!/usr/bin/env node\n// ${source}/packages/core\n// literal <owned-root> marker\n`);
      await symlink("../../../../packages/core", path.join(source, "apps/web/node_modules/@megaui/core"));
      await writeFile(path.join(source, "dist/removed.js"), "removed");
      const observer = {
        onTaskStart: async () => {
          started += 1;
          active += 1;
          peak = Math.max(peak, active);
          if (started === 4) release();
          await barrier;
        },
        onTaskEnd: () => { active -= 1; },
      };
      await Promise.all([
        copyOwnedSource(source, destinationOne, undefined, observer),
        copyOwnedSource(source, destinationTwo),
      ]);
      release();
      expect(peak).toBe(4);
      expect(started).toBeGreaterThanOrEqual(4);
      expect(await readFile(path.join(destinationOne, "apps/web/.env.example"), "utf8")).toBe("allowed");
      expect(await readFile(path.join(destinationOne, "node_modules/pkg/dist/kept.js"), "utf8")).toBe("kept");
      expect((await stat(path.join(destinationOne, "node_modules/.pnpm")).then(value => value.mode)) & 0o7777)
        .toBe((await stat(path.join(source, "node_modules/.pnpm")).then(value => value.mode)) & 0o7777);
      await expect(access(path.join(destinationOne, "apps/web/.env.local"))).rejects.toThrow();
      await expect(access(path.join(destinationOne, "node_modules/pkg/.env"))).rejects.toThrow();
      await expect(access(path.join(destinationOne, "node_modules/pkg/.tmp/removed.js"))).rejects.toThrow();
      await expect(access(path.join(destinationOne, "dist/removed.js"))).rejects.toThrow();
      expect(await readFile(path.join(destinationOne, "node_modules/.bin/tool"), "utf8")).toContain(destinationOne);
      expect(await readFile(path.join(destinationTwo, "node_modules/.bin/tool"), "utf8")).toContain(destinationTwo);
      expect(await readFile(path.join(source, "node_modules/.bin/tool"), "utf8")).toContain(source);
      expect(await readFile(path.join(destinationTwo, "packages/core/index.ts"), "utf8")).toBe("source");
      await writeFile(path.join(destinationOne, "packages/core/index.ts"), "private mutation");
      expect(await readFile(path.join(destinationTwo, "packages/core/index.ts"), "utf8")).toBe("source");

      outside = await mkdtemp(path.join(tmpdir(), "megaui-copy-outside-"));
      await symlink(outside, path.join(source, "apps/web/node_modules/@megaui/outside"));
      let boundaryFailure: unknown;
      try { await copyOwnedSource(source, path.join(parentOne, "bad")); }
      catch (error) { boundaryFailure = error; }
      expect(boundaryFailure).toBeInstanceOf(AggregateError);
      expect(String((boundaryFailure as AggregateError).cause)).toContain("escapes");
      const symlinkDestination = path.join(parentOne, "symlink-destination");
      await symlink(parentTwo, symlinkDestination);
      await expect(copyOwnedSource(source, symlinkDestination)).rejects.toThrow("Owned destination root");
    } finally {
      release();
      await cleanupOwnedPaths([source, parentOne, parentTwo, outside]);
    }
  }, 120_000);

  it("matches serial filtering, preserves private links, and joins bounded-copy failures", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "megaui-copy-equivalence-source-"));
    const serialParent = await mkdtemp(path.join(tmpdir(), "megaui-copy-equivalence-serial-"));
    const ownerOneParent = await mkdtemp(path.join(tmpdir(), "megaui-copy-equivalence-owner-one-"));
    const ownerTwoParent = await mkdtemp(path.join(tmpdir(), "megaui-copy-equivalence-owner-two-"));
    const roots: string[] = [source, serialParent, ownerOneParent, ownerTwoParent];
    const serialDestination = path.join(serialParent, "source");
    const ownerOneDestination = path.join(ownerOneParent, "source");
    const ownerTwoDestination = path.join(ownerTwoParent, "source");
    const serialFilter = (value: string): boolean => {
      const relative = path.relative(source, value);
      const parts = relative ? relative.split(path.sep) : [];
      const name = path.basename(value);
      if ((name.startsWith(".env") && name !== ".env.example" && name !== ".env.test.example") || name.endsWith(".tsbuildinfo")) return false;
      if (!parts.includes("node_modules") && new Set([".git", ".libra", ".turbo", ".next", ".pnpm-store", ".cache", ".vite", "coverage", "dist", "test-results", "playwright-report"]).has(name)) return false;
      return !(parts.includes("node_modules") && [".cache", ".vite", ".tmp"].includes(name));
    };
    try {
      await mkdir(path.join(source, "apps/web"), { recursive: true });
      await mkdir(path.join(source, "apps/web/node_modules/@megaui"), { recursive: true });
      await mkdir(path.join(source, "packages/core"), { recursive: true });
      await mkdir(path.join(source, "node_modules/.pnpm/pkg@1/node_modules/pkg"), { recursive: true });
      await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
      await mkdir(path.join(source, "node_modules/pkg/dist"), { recursive: true });
      await writeFile(path.join(source, "apps/web/.env.example"), "allowed");
      await writeFile(path.join(source, "apps/web/.env.local"), "must never be opened");
      await chmod(path.join(source, "apps/web/.env.local"), 0o000);
      await writeFile(path.join(source, "packages/core/index.ts"), "core");
      await symlink("../../../../packages/core", path.join(source, "apps/web/node_modules/@megaui/core"));
      await writeFile(path.join(source, "node_modules/.pnpm/pkg@1/node_modules/pkg/index.js"), "package");
      await writeFile(path.join(source, "node_modules/.bin/tool"), `#!/usr/bin/env node\n// ${source}/packages/core\n`);
      await writeFile(path.join(source, "node_modules/pkg/dist/kept.js"), "kept");
      await writeFile(path.join(source, "packages/core/type-change.ts"), "type source");
      await chmod(path.join(source, "node_modules/.pnpm"), 0o500);
      const oracleExpectedOne = await sourceOracleManifest(source, ownerOneDestination);
      const oracleExpectedTwo = await sourceOracleManifest(source, ownerTwoDestination);
      await cp(source, serialDestination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: serialFilter });
      await Promise.all([
        copyOwnedSource(source, ownerOneDestination),
        copyOwnedSource(source, ownerTwoDestination),
      ]);
      const serialLauncher = path.join(serialDestination, "node_modules/.bin/tool");
      await writeFile(serialLauncher, (await readFile(serialLauncher, "utf8")).replaceAll(source, ownerOneDestination));
      expect(await manifest(ownerOneDestination)).toEqual(await manifest(serialDestination));
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination))).toEqual([]);
      expect(oracleDifferences(oracleExpectedTwo, await candidateOracleManifest(ownerTwoDestination))).toEqual([]);
      expect(await sourceOracleManifest(source, ownerOneDestination)).toEqual(oracleExpectedOne);
      expect(await sourceOracleManifest(source, ownerTwoDestination)).toEqual(oracleExpectedTwo);

      const oracleFile = path.join(ownerOneDestination, "packages/core/index.ts");
      const oracleFileBytes = await readFile(oracleFile);
      const oracleFileMode = (await lstat(oracleFile)).mode & 0o7777;
      await rm(oracleFile);
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await writeFile(oracleFile, oracleFileBytes);
      await chmod(oracleFile, oracleFileMode);
      await writeFile(oracleFile, "oracle content mutation");
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await writeFile(oracleFile, oracleFileBytes);
      await chmod(oracleFile, 0o600);
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await chmod(oracleFile, oracleFileMode);

      const oracleType = path.join(ownerOneDestination, "packages/core/type-change.ts");
      await writeFile(oracleType, "type source");
      const oracleTypeBytes = await readFile(oracleType);
      const oracleTypeMode = (await lstat(oracleType)).mode & 0o7777;
      await rm(oracleType);
      await mkdir(oracleType);
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await rm(oracleType, { recursive: true });
      await writeFile(oracleType, oracleTypeBytes);
      await chmod(oracleType, oracleTypeMode);

      const oracleExtra = path.join(ownerOneDestination, "packages/core/extra.ts");
      await writeFile(oracleExtra, "extra");
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await rm(oracleExtra);
      const oracleLink = path.join(ownerOneDestination, "apps/web/node_modules/@megaui/core");
      await rm(oracleLink);
      await symlink("../../../../packages/missing", oracleLink);
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await rm(oracleLink);
      await symlink("../../../../packages/core", oracleLink);
      const oracleLauncher = path.join(ownerOneDestination, "node_modules/.bin/tool");
      const launcherBytes = await readFile(oracleLauncher, "utf8");
      await writeFile(oracleLauncher, launcherBytes.replaceAll(ownerOneDestination, source));
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await writeFile(oracleLauncher, launcherBytes);
      await writeFile(oracleLauncher, launcherBytes.replaceAll(ownerOneDestination, "<owned-root>"));
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination)).length).toBeGreaterThan(0);
      await writeFile(oracleLauncher, launcherBytes);
      await expect(access(path.join(ownerOneDestination, "apps/web/.env.local"))).rejects.toThrow();

      const sourceLauncherBytes = await readFile(path.join(source, "node_modules/.bin/tool"), "utf8");
      const expectedOwnerTwoLauncher = sourceLauncherBytes.replaceAll(source, ownerTwoDestination);
      expect(await readFile(path.join(ownerTwoDestination, "node_modules/.bin/tool"), "utf8")).toBe(expectedOwnerTwoLauncher);
      const mutationCases = [
        { label: "source", relative: "packages/core/index.ts" },
        { label: "dependency", relative: "node_modules/.pnpm/pkg@1/node_modules/pkg/index.js" },
        { label: "launcher", relative: "node_modules/.bin/tool" },
      ] as const;
      const ownerRoots = [ownerOneDestination, ownerTwoDestination] as const;
      for (const [ownerIndex, ownerRoot] of ownerRoots.entries()) {
        const peerRoot = ownerRoots[ownerIndex === 0 ? 1 : 0]!;
        for (const mutation of mutationCases) {
          const sourcePath = path.join(source, mutation.relative);
          const ownerPath = path.join(ownerRoot, mutation.relative);
          const peerPath = path.join(peerRoot, mutation.relative);
          const sourceBefore = await readFile(sourcePath);
          const ownerBefore = await readFile(ownerPath);
          const peerBefore = await readFile(peerPath);
          const changed = `owner-${ownerIndex + 1}-${mutation.label}-mutation`;
          await writeFile(ownerPath, changed);
          expect(await readFile(ownerPath, "utf8")).toBe(changed);
          expect(await readFile(sourcePath)).toEqual(sourceBefore);
          expect(await readFile(peerPath)).toEqual(peerBefore);
          await writeFile(ownerPath, ownerBefore);
        }
      }
      expect(oracleDifferences(oracleExpectedOne, await candidateOracleManifest(ownerOneDestination))).toEqual([]);
      expect(oracleDifferences(oracleExpectedTwo, await candidateOracleManifest(ownerTwoDestination))).toEqual([]);
      expect(await readFile(path.join(source, "node_modules/.bin/tool"), "utf8")).toBe(sourceLauncherBytes);
      expect(await sourceOracleManifest(source, ownerOneDestination)).toEqual(oracleExpectedOne);
      expect(await sourceOracleManifest(source, ownerTwoDestination)).toEqual(oracleExpectedTwo);

      const outside = await mkdtemp(path.join(tmpdir(), "megaui-copy-equivalence-outside-"));
      roots.push(outside);
      const unsafeSource = await mkdtemp(path.join(tmpdir(), "megaui-copy-unsafe-source-"));
      roots.push(unsafeSource);
      await mkdir(path.join(unsafeSource, "apps/web/node_modules/@megaui"), { recursive: true });
      await symlink(outside, path.join(unsafeSource, "apps/web/node_modules/@megaui/external"));
      await expect(copyOwnedSource(unsafeSource, path.join(ownerOneParent, "external-link"))).rejects.toBeInstanceOf(AggregateError);

      const danglingSource = await mkdtemp(path.join(tmpdir(), "megaui-copy-dangling-source-"));
      roots.push(danglingSource);
      await symlink("missing-target", path.join(danglingSource, "dangling"));
      await expect(copyOwnedSource(danglingSource, path.join(ownerOneParent, "dangling-link"))).rejects.toBeInstanceOf(AggregateError);

      const cyclicSource = await mkdtemp(path.join(tmpdir(), "megaui-copy-cyclic-source-"));
      roots.push(cyclicSource);
      await symlink("cycle-b", path.join(cyclicSource, "cycle-a"));
      await symlink("cycle-a", path.join(cyclicSource, "cycle-b"));
      await expect(copyOwnedSource(cyclicSource, path.join(ownerOneParent, "cyclic-link"))).rejects.toBeInstanceOf(AggregateError);
      await expect(copyOwnedSource(source, path.join(source, "nested-destination"))).rejects.toThrow("outside source root");

      const observerSource = await mkdtemp(path.join(tmpdir(), "megaui-copy-observer-source-"));
      const observerParent = await mkdtemp(path.join(tmpdir(), "megaui-copy-observer-destination-"));
      roots.push(observerSource, observerParent);
      await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(path.join(observerSource, `file-${index}.txt`), String(index))));
      const startedFour = deferred();
      const release = deferred();
      let started = 0;
      let firstEnd = true;
      const observerCopy = copyOwnedSource(observerSource, path.join(observerParent, "source"), undefined, {
        onTaskStart: () => {
          started += 1;
          if (started === 4) startedFour.resolve();
          return started > 1 ? release.promise : undefined;
        },
        onTaskEnd: () => {
          if (firstEnd) {
            firstEnd = false;
            throw new Error("synthetic observer failure");
          }
        },
      });
      await startedFour.promise;
      const outcome = observerCopy.then(() => "resolved", () => "rejected");
      await delay(10);
      expect(await Promise.race([outcome, delay(20).then(() => "pending")])).toBe("pending");
      release.resolve();
      await expect(observerCopy).rejects.toBeInstanceOf(AggregateError);
      const settledManifest = await manifest(path.join(observerParent, "source"));
      await delay(20);
      expect(await manifest(path.join(observerParent, "source"))).toEqual(settledManifest);

      const raceSource = await mkdtemp(path.join(tmpdir(), "megaui-copy-race-source-"));
      const raceParent = await mkdtemp(path.join(tmpdir(), "megaui-copy-race-destination-"));
      roots.push(raceSource, raceParent);
      const raceDestination = path.join(raceParent, "source");
      const raceFile = path.join(raceSource, "race.txt");
      await mkdir(path.join(raceSource, "apps/web/node_modules/@megaui"), { recursive: true });
      await mkdir(path.join(raceSource, "packages/core"), { recursive: true });
      await symlink("../../../../packages/core", path.join(raceSource, "apps/web/node_modules/@megaui/core"));
      await writeFile(raceFile, "before-copy");
      const raceOracle = await sourceOracleManifest(raceSource, raceDestination);
      await copyOwnedSource(raceSource, raceDestination, undefined, {
        onTaskStart: async () => { await writeFile(raceFile, "changed-during-copy"); },
      });
      expect(oracleDifferences(raceOracle, await candidateOracleManifest(raceDestination)).length).toBeGreaterThan(0);
      expect(oracleDifferences(raceOracle, await sourceOracleManifest(raceSource, raceDestination)).length).toBeGreaterThan(0);
    } finally {
      await cleanupOwnedPaths(roots);
    }
  }, 120_000);

  it("matches the real installed tree and isolates source, dependency, and launcher mutations", async () => {
    const sourceRoot = path.resolve(process.cwd());
    const candidateParent = await mkdtemp(path.join(tmpdir(), "megaui-installed-candidate-"));
    const candidateDestination = path.join(candidateParent, "source");
    const mutationPaths = ["packages/core/package.json", "node_modules/.pnpm/lock.yaml", "node_modules/.bin/tsx"];
    try {
      const sourceOracle = await sourceOracleManifest(sourceRoot, candidateDestination);
      const sourceRealRoot = await realpath(sourceRoot);
      const sourceBytes = await Promise.all(mutationPaths.map(relative => readFile(path.join(sourceRoot, relative))));
      await copyOwnedSource(sourceRoot, candidateDestination);
      const oracleDifferencesFound = oracleDifferences(
        sourceOracle,
        await candidateOracleManifest(candidateDestination),
      );
      expect(oracleDifferencesFound).toEqual([]);
      expect(await sourceOracleManifest(sourceRoot, candidateDestination)).toEqual(sourceOracle);

      const candidateBytes = await Promise.all(mutationPaths.map(relative => readFile(path.join(candidateDestination, relative))));
      for (const [index, relative] of mutationPaths.entries()) {
        await writeFile(path.join(candidateDestination, relative), `owner-two-${index}`);
        expect(await readFile(path.join(sourceRoot, relative))).toEqual(sourceBytes[index]);
        expect(await readFile(path.join(candidateDestination, relative), "utf8")).toBe(`owner-two-${index}`);
      }
      expect(candidateBytes[0]).toEqual(sourceBytes[0]);
      expect(candidateBytes[1]).toEqual(sourceBytes[1]);
      const expectedLauncher = sourceBytes[2]!.toString("utf8")
        .replaceAll(sourceRoot, candidateDestination)
        .replaceAll(sourceRealRoot, candidateDestination);
      expect(candidateBytes[2]!.toString("utf8")).toBe(expectedLauncher);
      expect(await sourceOracleManifest(sourceRoot, candidateDestination)).toEqual(sourceOracle);
    } finally {
      await cleanupOwnedPaths([candidateParent]);
    }
  }, 900_000);

  it("ignores an external target, shares its DML DB with actual mint/Auth, and preserves foreign resources", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "megaui-contract-sentinel-"));
    let foreign: postgres.IsolatedPostgres | undefined;
    let observer: ReturnType<typeof createDatabaseClient> | undefined;
    const sentinel = path.join(directory, "unchanged");
    const before = { DATABASE_URL: process.env.DATABASE_URL, ENTERPRISE_OWNER_FINGERPRINT: process.env.ENTERPRISE_OWNER_FINGERPRINT };
    const fixture = ownedContractFixture();
    async function cleanup() {
      const results = await Promise.allSettled([fixture.close(), observer?.close()]);
      results.push(...await Promise.allSettled([foreign?.destroy(), rm(directory, { recursive: true, force: true })]));
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      const errors = results.filter(result => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(error => error.reason), "Contract test cleanup failed");
    }
    try {
      foreign = await createIsolatedPostgres();
      observer = createDatabaseClient({ connectionString: foreign.databaseUrl });
      await observer.pool.query("create table sentinel(value text); insert into sentinel values ('untouched')");
      await writeFile(sentinel, "untouched");
      process.env.DATABASE_URL = foreign.databaseUrl;
      process.env.ENTERPRISE_OWNER_FINGERPRINT = "foreign-config-must-not-enter-auth";
      await fixture.start();
      const resources = fixture.resources()!;
      expect(resources.databaseName === foreign.databaseName).toBe(false);
      const row = (await getPool().query(`select current_database() as db, current_user as role,
        has_schema_privilege(current_user, 'public', 'CREATE') as can_ddl`)).rows[0];
      expect(row).toEqual({ db: resources.databaseName, role: "owned_contract_web", can_ddl: false });
      const envNames = (await readdir(path.join(resources.directory, "source/apps/web")))
        .filter(name => name.startsWith(".env") && ![".env.example", ".env.test.example"].includes(name));
      expect(envNames).toEqual([]);
      const cookie = await fixture.mint();
      const session = await getAuth().api.getSession({ headers: new Headers({ Cookie: cookie }) });
      // Never let a failing assertion print a session, Cookie or password.
      expect(typeof session?.user.id === "string" && session.user.id.length > 0).toBe(true);
      expect((await getPool().query('select count(*)::int as count from "session"')).rows[0].count).toBeGreaterThan(0);
      await fixture.close();
      expect(process.env.DATABASE_URL === foreign.databaseUrl).toBe(true);
      expect(process.env.ENTERPRISE_OWNER_FINGERPRINT).toBe("foreign-config-must-not-enter-auth");
      expect((await observer.pool.query("select value from sentinel")).rows).toEqual([{ value: "untouched" }]);
      expect((await observer.pool.query("select to_regclass('public.user') as auth_table")).rows[0].auth_table).toBeNull();
      expect(await readFile(sentinel, "utf8")).toBe("untouched");
      await removed(resources);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("cleans a real migrated PG and copied source after seed fails", async () => {
    const fixture = ownedContractFixture({ seed: async () => { throw new Error("synthetic seed failure"); } });
    try {
      await expect(fixture.start()).rejects.toThrow("synthetic seed failure");
      await removed(fixture.resources()!);
    } finally { await fixture.close(); }
  }, 120_000);

  it("joins in-flight setup before cleanup and never publishes late readiness", async () => {
    const entered = deferred(); const release = deferred();
    const fixture = ownedContractFixture({ seed: async () => { entered.resolve(); await release.promise; } });
    const start = fixture.start();
    const rejected = expect(start).rejects.toThrow("Owned contract setup was closed");
    try {
      await entered.promise;
      const closing = fixture.close();
      release.resolve();
      await rejected; await closing;
      await expect(fixture.mint()).rejects.toThrow("not ready");
      await removed(fixture.resources()!);
    } finally { release.resolve(); await fixture.close(); }
  }, 120_000);

  it("can close an unstarted lifetime without allocating resources", async () => {
    const fixture = ownedContractFixture();
    expect(fixture.resources()).toBeUndefined();
    await fixture.close();
    await expect(fixture.start()).rejects.toThrow("unavailable");
    expect(fixture.resources()).toBeUndefined();
  });

  it.each(["abort", "copy failure", "migration failure"])("joins parallel preparation for %s before removing owned resources", async mode => {
    const release = deferred(); const entered = deferred(); const failedMigration = deferred();
    const controller = new AbortController();
    const events: string[] = [];
    const captured: { owner?: OwnedWeb } = {};
    let database: postgres.IsolatedPostgres | undefined;
    let returned = false;
    const originalCreate = postgres.createIsolatedPostgres;
    const databaseSpy = vi.spyOn(postgres, "createIsolatedPostgres").mockImplementation(async (...args) => {
      database = await originalCreate(...args);
      const destroy = database.destroy; const migrate = database.migrate;
      database.destroy = async () => { events.push("destroy"); await destroy(); };
      if (mode === "migration failure") database.migrate = async () => {
        await migrate(); failedMigration.resolve(); throw new Error("synthetic migration failure");
      };
      return database;
    });
    // Hold a real filesystem operation open while the actual PG branch starts.
    // It writes after release, making premature directory cleanup observable.
    const copySpy = vi.spyOn(OwnedWeb.prototype as unknown as { copySource(): Promise<void> }, "copySource")
      .mockImplementation(async function(this: OwnedWeb) {
        captured.owner = this; entered.resolve(); await release.promise;
        await mkdir(this.root, { recursive: true });
        await writeFile(path.join(this.root, "late-copy.txt"), "owned");
        events.push("copy-terminal");
        if (mode === "copy failure") throw new Error("synthetic copy failure");
      });
    const setup = OwnedWeb.create(controller.signal).then(() => { returned = true; return true; }, () => { returned = true; return false; });
    try {
      await entered.promise;
      await vi.waitFor(() => expect(database !== undefined).toBe(true), { timeout: 60_000, interval: 50 });
      if (mode === "migration failure") {
        await failedMigration.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(events.includes("destroy")).toBe(false);
      }
      expect(returned).toBe(false);
      if (mode === "abort") controller.abort();
      release.resolve();
      expect(await setup).toBe(false);
      expect(events.indexOf("copy-terminal")).toBeLessThan(events.indexOf("destroy"));
      await removed({ directory: captured.owner!.directory, databaseName: database!.databaseName });
    } finally {
      controller.abort(); release.resolve(); await setup;
      try { await captured.owner?.close(); }
      finally { copySpy.mockRestore(); databaseSpy.mockRestore(); }
    }
  }, 120_000);

  it("closes a real mint Pool after authentication fails and exits naturally without successful cookies", async () => {
    await withOwnedWeb(async owner => {
      const observer = owner.createDatabaseObserver();
      const password = randomBytes(24).toString("hex");
      await observer.pool.query(`create role mint_denied login password '${password}';
        grant usage on schema public to mint_denied;
        grant select on all tables in schema public to mint_denied`);
      const url = new URL(owner.env.DATABASE_URL!);
      url.username = "mint_denied"; url.password = password;
      owner.env.DATABASE_URL = url.toString();
      const marker = path.join(owner.root, "mint-exit.json");
      await owner.writeTestFile("packages/database/src/mint-lifecycle-probe.mjs", `import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
const end = Pool.prototype.end;
let closed = false;
Pool.prototype.end = function(...args) {
 const result = Reflect.apply(end, this, args);
 return result.then(value => { closed = true; return value; });
};
process.once('beforeExit', code => writeFileSync(process.env.MINT_EXIT_MARKER, JSON.stringify({code, closed})));\n`);
      let diagnostic: ReturnType<typeof readOwnedCommandDiagnostics>;
      try {
        await owner.run("pnpm", ["exec", "tsx", "--import", "./packages/database/src/mint-lifecycle-probe.mjs", "apps/web/tests/e2e/helpers/mint-session-cli.ts"], 30_000,
          { MINT_EXIT_MARKER: marker });
      } catch (error) { diagnostic = readOwnedCommandDiagnostics(error); }
      expect(diagnostic?.code).toBe(1); expect(diagnostic?.signal).toBeNull();
      expect(diagnostic?.stdout.trim().length === 0).toBe(true);
      expect(/permission denied|42501/.test(diagnostic?.stderr ?? "")).toBe(true);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ code: 1, closed: true });
      const count = (await observer.pool.query("select count(*)::int as count from pg_stat_activity where datname=$1 and usename='mint_denied'",
        [decodeURIComponent(url.pathname.slice(1))])).rows[0].count;
      expect(count).toBe(0);
    });
  }, 120_000);
});
