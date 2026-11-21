// megaui-only (FSL-150): AC6, a Feishu-mode Web process exits within 10 seconds of a real SIGTERM.
//
// The Web runs as its own `next dev` child (its own process group) from an owned copy of the
// source (FS-92 `OwnedWeb`: one-shot PostgreSQL, no real .env), configured for Feishu mode with
// the Feishu Mock as its simulator provider. Readiness is the first healthy `/api/health`
// answer: Next awaits `register()` before it handles any request, and the expired row seeded
// beforehand is then already void, which shows that the Feishu-mode `register()` ran. A single
// SIGTERM goes to the Next process itself; it must exit with code 0 or by that signal within
// 10 seconds, and no process of its group may remain. `instrumentation.ts` itself must not
// register any SIGTERM / SIGINT handler (shutdown keeps Next's default behaviour).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { isDockerAvailable } from "@megaui/database/test-support";

import { startFeishuMock } from "../e2e/helpers/feishu-mock";
import { withOwnedWeb } from "../helpers/owned-web";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/web] feishu-login-shutdown.spec.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXIT_BUDGET_MS = 10_000;
const READY_TIMEOUT_MS = 240_000;

/** The live (non-zombie) members of a process group, from the process table. */
function groupMembers(pgid: number): string[] {
  const table = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  return table.trim().split("\n").map(row => row.trim().split(/\s+/))
    .filter(row => Number(row[1]) === pgid && !row[2]?.startsWith("Z"))
    .map(row => row[0]!);
}

function killGroup(pgid: number): void {
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
}

describe("FSL-150 Feishu-mode Web shutdown", () => {
  it("instrumentation.ts registers no SIGTERM / SIGINT handler", () => {
    const source = readFileSync(path.join(WEB_ROOT, "instrumentation.ts"), "utf8");
    expect(source).not.toMatch(/\bprocess\s*\.\s*(on|once|addListener|prependListener|prependOnceListener)\s*\(/);
    expect(source).not.toMatch(/SIGTERM|SIGINT/);
  });

  it("AC6: the Web process exits within 10 seconds of a real SIGTERM, leaving no process behind", async () => {
    const mock = await startFeishuMock();
    try {
      await withOwnedWeb(async (owner) => {
        const observer = owner.createDatabaseObserver();
        const id = randomUUID();
        const hex = () => randomBytes(32).toString("hex");
        await observer.pool.query(
          `insert into feishu_login_codes
             (id, flow_hash, flow_seq, email_hmac, email_seq, state, email, open_id, display_name, code_hmac,
              failed_attempts, expires_at, created_at)
           values ($1, $2, 1, $3, 1, 'active', 'alice@example.com', 'ou_mock_alice', 'Mock Alice', $4, 0,
                   now() - interval '5 minutes', now() - interval '10 minutes')`,
          [id, hex(), hex(), hex()],
        );
        const env: NodeJS.ProcessEnv = {
          ...owner.env,
          NODE_ENV: "development",
          AUTH_MODE: "enterprise",
          AUTH_PROVIDER: "feishu",
          FEISHU_APP_ID: mock.runtime.appId,
          FEISHU_APP_SECRET: mock.runtime.appSecret,
          ENTERPRISE_OTP_HMAC_KEY: randomBytes(32).toString("base64url"),
          FEISHU_PROVIDER: "simulator",
          FEISHU_SIMULATOR_ORIGIN: mock.baseUrl,
        };
        const nextBin = path.join(owner.root, "apps/web/node_modules/next/dist/bin/next");
        const child: ChildProcess = spawn(process.execPath,
          [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(owner.port)],
          { cwd: path.join(owner.root, "apps/web"), env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
        const pgid = child.pid;
        if (!pgid) throw new Error("the Web child has no pid");
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(resolve => {
          child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() }));
        });
        try {
          const readyBy = Date.now() + READY_TIMEOUT_MS;
          let ready = false;
          while (!ready && Date.now() < readyBy) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error("the Web child exited before readiness");
            try {
              const response = await fetch(`${owner.baseURL}/api/health`, { signal: AbortSignal.timeout(30_000) });
              ready = response.ok && ((await response.json()) as { status?: string }).status === "healthy";
            } catch { /* not ready yet */ }
            if (!ready) await delay(250);
          }
          if (!ready) throw new Error("the Web child did not become ready");
          // register() ran in Feishu mode before the first request was answered.
          const row = (await observer.pool.query<{ state: string }>("select state from feishu_login_codes where id = $1", [id])).rows[0];
          expect(row?.state).toBe("void");

          const sentAt = Date.now();
          process.kill(pgid, "SIGTERM");
          const exited = await Promise.race([exit, delay(EXIT_BUDGET_MS + 5_000).then(() => undefined)]);
          expect(exited, "the Web child did not exit after SIGTERM").toBeDefined();
          expect(exited!.at - sentAt).toBeLessThan(EXIT_BUDGET_MS);
          expect(exited!.code === 0 || exited!.signal === "SIGTERM", `exit ${exited!.code} ${exited!.signal}`).toBe(true);
          // No process of the Web group is left in the process table within the same budget.
          let members = groupMembers(pgid);
          while (members.length > 0 && Date.now() - sentAt < EXIT_BUDGET_MS) {
            await delay(100);
            members = groupMembers(pgid);
          }
          expect(members).toEqual([]);
        } finally {
          killGroup(pgid);
        }
      });
    } finally {
      await mock.stop();
    }
  }, 600_000);
});
