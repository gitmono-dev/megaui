// megaui-only (FIX-FS-02): resolve the public config, then exercise real workers.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "vitest/node";

const root = fileURLToPath(new URL("../..", import.meta.url));
async function configuredWorkers(): Promise<string> {
  const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const step = workflow.split("- name: Unit tests (CMD-05)")[1]?.split("- name:")[0] ?? "";
  expect(step).toMatch(/run: pnpm vitest run\s/);
  const workers = step.match(/VITEST_MAX_WORKERS:\s*['"]?(\d+)/)?.[1];
  expect(workers).toBe("2");
  expect(workflow).toContain("timeout-minutes: 120");
  for (const name of ["Typecheck (CMD-01)", "Build (CMD-02)", "Lint (CMD-03)", "Secret residue guard (ER-11)",
    "Secret key guard", "Brand residue guard (OPS-02)", "Public assets guard (OPS-02)",
    "Docs relative links (OPS-02)", "License allowlist (OPS-02)"]) expect(workflow).toContain(`- name: ${name}`);
  return workers!;
}

/** The body of the workflow step named exactly `name`, up to the next step. */
function stepBody(workflow: string, name: string): string | undefined {
  const parts = workflow.split(`- name: ${name}\n`);
  expect(parts.length, name).toBeLessThanOrEqual(2);
  return parts[1]?.split("- name:")[0];
}

async function probe(directory: string, workers: string): Promise<void> {
  const child = spawn(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run"], {
    cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: process.env.HOME, PATH: process.env.PATH, NODE_ENV: "test", CI: "true", NO_COLOR: "1",
      MEGAUI_APP_NAME: "megaui", VITEST_MAX_WORKERS: workers, PROBE_EVENTS: path.join(directory, "events.jsonl") },
  });
  // Probe output contains only synthetic fixture results, but bounded diagnostics
  // still avoid attaching arbitrary subprocess output to assertion errors.
  child.stdout.resume(); child.stderr.resume();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; if (child.pid) process.kill(-child.pid, "SIGKILL"); }, 30_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(timedOut).toBe(false); expect(result).toEqual({ code: 0, signal: null });
  } finally { clearTimeout(timer); }
}

describe("CI guard steps (FSL-141)", () => {
  it("AC10: the workflow has no Live provider status step", async () => {
    const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).not.toMatch(/- name: Live provider status/);
    expect(workflow).not.toContain("NOT EXECUTED (DEFER-FS-03)");
  });

  it("AC11: the Secret key guard step runs check-secret-keys.sh and no enterprise guard is left", async () => {
    const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const step = stepBody(workflow, "Secret key guard");
    expect(step).toBeDefined();
    expect(step!.trim()).toBe("run: bash scripts/check-secret-keys.sh");
    expect(workflow).not.toMatch(/Enterprise secret guard|check-enterprise-secrets/);
  });
});

describe("complete CI test execution", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("resolves two workers with the existing complete root collection and isolation", async () => {
    vi.stubEnv("VITEST_MAX_WORKERS", await configuredWorkers());
    const { vitestConfig } = await resolveConfig({ root, config: path.join(root, "vitest.config.ts"), watch: false }, { envDir: false });
    expect(vitestConfig.maxWorkers).toBe(2);
    expect(vitestConfig.isolate).toBe(true);
    // The public resolver leaves the enabled default undefined; the next test
    // proves actual file overlap instead of treating an omitted field as false.
    expect(vitestConfig.fileParallelism).not.toBe(false);
    expect(vitestConfig.passWithNoTests).toBe(false);
    expect(vitestConfig.include).toEqual(["apps/**/*.{test,spec}.{ts,tsx}", "packages/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"]);
    expect(vitestConfig.exclude).toEqual(["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**", "**/tests/e2e/**"]);
  });

  it("runs four real files with exactly two overlapping workers under unchanged root configuration", async () => {
    const workers = await configuredWorkers();
    const directory = await mkdtemp(path.join(tmpdir(), "megaui-ci-workers-"));
    try {
      await writeFile(path.join(directory, "package.json"), '{"private":true,"type":"module"}');
      await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
      for (const relative of ["vitest.config.ts", "tests/setup-localstorage.ts", "apps/web/tests/contract/load-env.ts"]) {
        await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
        await cp(path.join(root, relative), path.join(directory, relative));
      }
      const source = `import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { setTimeout } from 'node:timers/promises';
import { it } from 'vitest';
it('bounded worker probe', async () => {
 const identity = process.pid + ':' + threadId;
 const emit = (kind) => appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({ identity, kind }) + '\\n');
 emit('start'); try { await setTimeout(700); } finally { emit('end'); }
});\n`;
      for (const name of ["one", "two", "three", "four"]) await writeFile(path.join(directory, `tests/${name}.test.ts`), source);
      await probe(directory, workers);
      const events = (await readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { identity: string; kind: "start" | "end" });
      const active = new Set<string>(); let peak = 0;
      for (const event of events) {
        if (event.kind === "start") { expect(active.has(event.identity)).toBe(false); active.add(event.identity); }
        else { expect(active.delete(event.identity)).toBe(true); }
        peak = Math.max(peak, active.size);
      }
      expect(events.filter(event => event.kind === "start")).toHaveLength(4);
      expect(active.size).toBe(0); expect(peak).toBe(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);
});
