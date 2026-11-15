import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const installer = join(root, "scripts/install-ci-ripgrep.sh");
const url = "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz";
const digest = "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599";

function withFixture(run: (fixture: ReturnType<typeof fixtureAt>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "megaui-ci-rg-"));
  try { run(fixtureAt(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  expect(existsSync(dir)).toBe(false);
}

/** Dependency fault injection; this fixture does not verify the official binary. */
function fixtureAt(dir: string) {
  const bin = join(dir, "mock-bin");
  const runner = join(dir, "runner temp");
  const githubPath = join(dir, "github-path");
  mkdirSync(bin); mkdirSync(runner); writeFileSync(githubPath, "");
  const command = (name: string, lines: string[]) =>
    writeFileSync(join(bin, name), "#!/bin/bash\nset -e\n" + lines.join("\n") + "\n", { mode: 0o755 });
  command("uname", [
    'if [ "$CI_FAIL" = platform ]; then echo Darwin; exit 0; fi',
    'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi',
  ]);
  command("curl", [
    'echo curl >> "$CI_TEST_ROOT/trace"',
    'printf "%s\\n" "$@" > "$CI_TEST_ROOT/curl-args"',
    'if [ "$CI_FAIL" = download ]; then exit 22; fi',
    'if [ "$CI_FAIL" = timeout ]; then exit 28; fi',
    'if [ "$CI_FAIL" = signal ]; then kill -TERM "$PPID"; exit 143; fi',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = --output ]; then shift; printf archive > "$1"; fi',
    '  shift',
    'done',
  ]);
  command("sha256sum", [
    'echo checksum >> "$CI_TEST_ROOT/trace"',
    'cat > "$CI_TEST_ROOT/checksum-input"',
    'if [ "$CI_FAIL" = checksum ]; then exit 1; fi',
  ]);
  command("tar", [
    'echo extract >> "$CI_TEST_ROOT/trace"',
    'if [ "$CI_FAIL" = extract ]; then exit 2; fi',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = -C ]; then shift; destination=$1; fi',
    '  shift',
    'done',
    'cat > "$destination/rg" <<\'RG\'',
    '#!/bin/bash',
    'echo executed >> "$CI_TEST_ROOT/trace"',
    'if [ "$CI_FAIL" = execute ]; then exit 3; fi',
    'if [ "$CI_FAIL" = publish ]; then rm "$GITHUB_PATH"; mkdir "$GITHUB_PATH"; fi',
    'if [ "$CI_FAIL" = version ]; then echo "ripgrep 99.0.0"; else echo "ripgrep 15.1.0"; fi',
    'RG',
  ]);
  const environment = (failure = "", extra: Record<string, string> = {}) => ({
    HOME: process.env.HOME, PATH: bin + delimiter + process.env.PATH,
    RUNNER_TEMP: runner, GITHUB_PATH: githubPath, CI_TEST_ROOT: dir, CI_FAIL: failure, ...extra,
  });
  function run(failure = "", extra: Record<string, string> = {}) {
    return spawnSync("bash", [installer], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: environment(failure, extra),
    });
  }
  return { dir, runner, githubPath, run, command, environment,
    trace: () => existsSync(join(dir, "trace")) ? readFileSync(join(dir, "trace"), "utf8").trim().split("\n") : [] };
}

describe("fixed-source CI ripgrep prerequisite (FIX-FS-01)", () => {
  it("ignores default curl configuration that would add retries or another URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "megaui-ci-rg-curlrc-"));
    let connections = 0;
    // A real curl TLS handshake fails locally; no request reaches GitHub.
    const server = createServer(socket => { connections++; socket.destroy(); });
    try {
      const f = fixtureAt(dir);
      const nativeCurl = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" });
      expect(nativeCurl.status).toBe(0);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing local TCP address");
      writeFileSync(join(dir, ".curlrc"), 'retry = 2\nretry-delay = 1\nretry-all-errors\nurl = "https://github.com/ignored-config-url"\n');
      f.command("curl", [
        'exec "$CI_NATIVE_CURL" "$@" --connect-to "github.com:443:127.0.0.1:$CI_TLS_PORT" --noproxy "*"',
      ]);
      const child = spawn("bash", [installer], { cwd: root, detached: true, stdio: "ignore",
        env: f.environment("", { HOME: dir, CURL_HOME: dir, XDG_CONFIG_HOME: dir,
          CI_NATIVE_CURL: nativeCurl.stdout.trim(), CI_TLS_PORT: String(address.port) }),
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch { child.kill("SIGKILL"); }
        }
      }, 10_000);
      let status: number | null;
      try {
        status = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally { clearTimeout(timer); }
      expect(timedOut).toBe(false);
      expect(status).toBe(35);
      expect(connections).toBe(1);
      expect(readFileSync(f.githubPath, "utf8")).toBe("");
      expect(readdirSync(f.runner)).toEqual([]);
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
    expect(existsSync(dir)).toBe(false);
  }, 15_000);

  it("publishes a verified tool only after checksum, extraction and version validation", () => withFixture(f => {
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.trace()).toEqual(["curl", "checksum", "extract", "executed"]);
    const published = readFileSync(f.githubPath, "utf8").trim();
    expect(published.startsWith(f.runner + "/")).toBe(true);
    expect(existsSync(join(published, "rg"))).toBe(true);
    expect(readdirSync(f.runner)).toEqual([published.slice(f.runner.length + 1)]);
    const args = readFileSync(join(f.dir, "curl-args"), "utf8").trim().split("\n");
    expect(args).toContain(url);
    expect(args.slice(args.indexOf("--connect-timeout"), args.indexOf("--connect-timeout") + 2)).toEqual(["--connect-timeout", "10"]);
    expect(args.slice(args.indexOf("--max-time"), args.indexOf("--max-time") + 2)).toEqual(["--max-time", "45"]);
    for (const flag of ["--proto", "--proto-redir"]) {
      expect(args.slice(args.indexOf(flag), args.indexOf(flag) + 2)).toEqual([flag, "=https"]);
    }
    expect(args).not.toContain("--retry");
    expect(readFileSync(join(f.dir, "checksum-input"), "utf8")).toMatch(new RegExp("^" + digest + "  "));
  }));

  it.each([
    ["download", 22, ["curl"]],
    ["timeout", 28, ["curl"]],
    ["checksum", 1, ["curl", "checksum"]],
    ["extract", 2, ["curl", "checksum", "extract"]],
    ["execute", 3, ["curl", "checksum", "extract", "executed"]],
    ["version", 1, ["curl", "checksum", "extract", "executed"]],
    ["signal", 143, ["curl"]],
  ] as const)("fails closed and cleans owned directories for %s", (failure, status, trace) => withFixture(f => {
    const result = f.run(failure);
    expect(result.status, result.stderr).toBe(status);
    expect(f.trace()).toEqual(trace);
    expect(readFileSync(f.githubPath, "utf8")).toBe("");
    expect(readdirSync(f.runner)).toEqual([]);
    expect(result.stdout).not.toContain("Installed ripgrep");
  }));

  it("cleans the unapproved tool directory when copying fails", () => withFixture(f => {
    f.command("install", ["exit 5"]);
    const result = f.run();
    expect(result.status).toBe(5);
    expect(f.trace()).toEqual(["curl", "checksum", "extract"]);
    expect(readFileSync(f.githubPath, "utf8")).toBe("");
    expect(readdirSync(f.runner)).toEqual([]);
  }));

  it("does not retain tools after PATH publication fails", () => withFixture(f => {
    const result = f.run("publish");
    expect(result.status).not.toBe(0);
    expect(readdirSync(f.runner)).toEqual([]);
    expect(result.stdout).not.toContain("Installed ripgrep");
  }));

  it("rejects an unsupported platform before fetching", () => withFixture(f => {
    expect(f.run("platform").status).not.toBe(0);
    expect(f.trace()).toEqual([]);
    expect(readdirSync(f.runner)).toEqual([]);
  }));

  it("rejects missing job paths before fetching", () => withFixture(f => {
    expect(f.run("", { RUNNER_TEMP: "" }).status).not.toBe(0);
    expect(f.run("", { GITHUB_PATH: "" }).status).not.toBe(0);
    expect(f.trace()).toEqual([]);
  }));

  it("rejects multiline PATH entries before fetching", () => withFixture(f => {
    const multiline = join(f.dir, "runner\nextra");
    mkdirSync(multiline);
    expect(f.run("", { RUNNER_TEMP: multiline }).status).not.toBe(0);
    expect(f.trace()).toEqual([]);
    expect(readdirSync(multiline)).toEqual([]);
  }));

  it("uses the fixed artifact even when an unrelated rg or override variables exist", () => withFixture(f => {
    f.command("rg", ["exit 77"]);
    expect(f.run("", { RIPGREP_URL: "https://invalid.example/tool", ci_rg_digest: "bad" }).status).toBe(0);
    expect(readFileSync(join(f.dir, "curl-args"), "utf8")).toContain(url);
    expect(readFileSync(join(f.dir, "checksum-input"), "utf8")).toMatch(new RegExp("^" + digest + "  "));
    expect(f.trace()).toEqual(["curl", "checksum", "extract", "executed"]);
  }));

  it("installs the prerequisite once, with a bounded step before dependency installation", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const invocation = "run: bash scripts/install-ci-ripgrep.sh";
    expect(workflow.split(invocation)).toHaveLength(2);
    const step = workflow.slice(workflow.indexOf("- name: Install ripgrep"), workflow.indexOf("- name: Install (CMD-00)"));
    expect(step).toContain("timeout-minutes: 2");
    expect(step).toContain(invocation);
    expect(step).not.toMatch(/continue-on-error:|if:/);
    expect(workflow).not.toContain("apt-get");
  });
});
