// megaui-only (FS-40): real child processes prove environment and lifecycle boundaries.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IsolatedServer, buildIsolatedEnvironment } from "../e2e/helpers/isolated-server";

const owners: IsolatedServer[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const owner of owners.splice(0).reverse()) {
    try { await owner.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "isolated-server test cleanup failed");
});

async function commandFixture(): Promise<{ directory: string; script: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "megaui-fs40-child-"));
  const script = path.join(directory, "server.mjs");
  await writeFile(script, `
    import { createServer } from "node:http";
    const port = Number(process.env.FS40_PORT);
    const server = createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
      res.writeHead(404); res.end();
    });
    server.listen(port, "127.0.0.1", () => console.log("Ready in 1ms"));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@megaui/web" }));
  return { directory, script };
}

describe("FS-40 isolated Web server", () => {
  it("constructs a filtered environment with private cache and home paths", async () => {
    const env = buildIsolatedEnvironment("/tmp/fs40-owned", { FS40_SECRET: "must-not-pass", DATABASE_URL: "postgres://owned" });
    expect(env.DATABASE_URL).toBe("postgres://owned");
    expect(env.FS40_SECRET).toBeUndefined();
    expect(env.HOME).toBe("/tmp/fs40-owned/home");
    expect(env.XDG_CACHE_HOME).toBe("/tmp/fs40-owned/cache");
  });

  it("starts, restarts with the same origin, and removes the private source snapshot", async () => {
    const fixture = await commandFixture();
    const server = await IsolatedServer.create({
      sourceRoot: fixture.directory,
      readyPath: "/health",
      command: _port => [process.execPath, "server.mjs"],
      env: { FS40_PORT: "0" },
    });
    owners.push(server);
    server.env.FS40_PORT = String(server.port);
    expect(await server.hasEnvironmentFiles()).toEqual([]);
    expect((await server.readLaunchEnvironment()).FS40_SECRET).toBeUndefined();
    await server.start();
    const origin = server.origin;
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    await server.restart();
    expect(server.origin).toBe(origin);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    await rm(fixture.directory, { recursive: true, force: true });
    expect(await readFile(path.join(server.root, "server.mjs"), "utf8")).toContain("Ready in");
  });

  it("fails closed when the fixed port is occupied and cleans the process group", async () => {
    const fixture = await commandFixture();
    const server = await IsolatedServer.create({
      sourceRoot: fixture.directory,
      readyPath: "/health",
      command: _port => [process.execPath, "server.mjs"],
      env: { FS40_PORT: "0" },
    });
    owners.push(server);
    server.env.FS40_PORT = String(server.port);
    const blocker = createServer().listen(server.port, "127.0.0.1");
    try {
      await expect(server.start()).rejects.toThrow();
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
});

