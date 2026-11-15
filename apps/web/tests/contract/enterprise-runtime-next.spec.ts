// megaui-only (FS-93): public Next lifecycle, real bundles/HMR, and legacy child consumers.
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "@megaui/database";
import { OwnedWeb, withOwnedWeb, readOwnedCommandDiagnostics, type OwnedCommandResult } from "../helpers/owned-web";

const probeModule = `import { getAuth } from "./auth";
import { getReadyWebAssembly, closeEnterpriseWebRuntime } from "./enterprise-runtime";
const key = Symbol.for("fs93.test.private-object-ids");
const ids = (globalThis as any)[key] ??= { map: new WeakMap(), next: 1, held: undefined };
function id(object: object) { if (!ids.map.has(object)) ids.map.set(object, ids.next++); return ids.map.get(object); }
export async function probe(operation: string) {
  if (operation === "close") return closeEnterpriseWebRuntime();
  const auth = getAuth(); const assembly = getReadyWebAssembly()!;
  if (operation === "hold") { ids.held = await assembly.database.pool.connect(); return { held: true }; }
  const row = (await assembly.database.pool.query("select pg_backend_pid() as pid")).rows[0];
  return { auth: id(auth), pool: id(assembly.database.pool), sameAuth: auth === assembly.auth, pid: row.pid };
}
`;
// A full Next build can exceed the helper's generic 120s command deadline on
// the Linux CI runner while the other bounded worker is active. Keep the
// outer test budget unchanged and widen only this existing build command.
const NEXT_BUILD_TIMEOUT = 180_000;
async function installProbes(owner: OwnedWeb) {
  await owner.writeTestFile("apps/web/lib/owned-runtime-probe.ts", probeModule);
  await owner.writeTestFile("apps/web/app/api/owned-runtime/route.ts", `import { probe } from "@/lib/owned-runtime-probe";
export const dynamic = "force-dynamic";
export async function GET() { try { return Response.json(await probe("snapshot")); } catch { return Response.json({ unavailable: true }, { status: 503 }); } }
`);
  await owner.writeTestFile("apps/web/pages/api/owned-runtime-pages.ts", `import type { NextApiRequest, NextApiResponse } from "next";
import { probe } from "@/lib/owned-runtime-probe";
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try { res.status(200).json(await probe(req.method === "POST" ? String(req.query.operation) : "snapshot")); }
  catch { res.status(503).json({ unavailable: true }); }
}
`);
}
async function configureEnterprise(owner: OwnedWeb, observer: DatabaseClient) {
  const database = decodeURIComponent(new URL(owner.env.DATABASE_URL!).pathname.slice(1)).replaceAll('"', '""');
  await observer.pool.query(`create role fs93_next_web login password 'synthetic-next-password';
    revoke create on schema public from public; revoke create on database "${database}" from public;
    grant connect on database "${database}" to fs93_next_web;
    grant usage on schema public to fs93_next_web;
    grant select,insert,update,delete on all tables in schema public to fs93_next_web;
    grant usage,select on all sequences in schema public to fs93_next_web;
    insert into enterprise_policy(id,scope,owner_fingerprint,deployment_role,environment,activation_state,auth_epoch)
      values ('fs93-next','fs93-next','owned','test','test','enterprise',1)`);
  const url = new URL(owner.env.DATABASE_URL!); url.username = "fs93_next_web"; url.password = "synthetic-next-password";
  Object.assign(owner.env, { DATABASE_URL: url.toString(), AUTH_MODE: "enterprise", ENTERPRISE_PROCESS_ROLE: "web",
    ENTERPRISE_OWNER_FINGERPRINT: "owned", ENTERPRISE_DB_INSTANCE_ID: "fs93-next", ENTERPRISE_DEPLOYMENT_ROLE: "test",
    FEISHU_TENANT_KEY: "tenant", FEISHU_APP_ID: "app", ENTERPRISE_IP_HMAC_MASTER_KEY: Buffer.alloc(32, 11).toString("base64url"),
    ENTERPRISE_TRUSTED_PROXY_CIDRS: "[]" });
}
async function backendCount(observer: DatabaseClient) {
  return (await observer.pool.query(`select count(*)::int as count from pg_stat_activity
    where usename='fs93_next_web' and datname=current_database()`)).rows[0].count as number;
}
async function fetchProbe(owner: OwnedWeb, pages = false, operation?: string) {
  const response = await fetch(`${owner.baseURL}/api/${pages ? "owned-runtime-pages" : "owned-runtime"}${operation ? `?operation=${operation}` : ""}`,
    { method: operation ? "POST" : "GET", signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function compiledMarker(directory: string, marker: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (await compiledMarker(name, marker)) return true; }
    else if (/\.(?:js|map)$/.test(entry.name) && (await readFile(name, "utf8")).includes(marker)) return true;
  }
  return false;
}
function expectRealExit(result: OwnedCommandResult) {
  // Next owns SIGTERM handling. It need not exit zero and does not await an arbitrary app listener.
  expect(result.code === 0 || result.code === 143 || result.signal === "SIGTERM").toBe(true);
}
function childJson(result: OwnedCommandResult): Record<string, unknown> {
  try { return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>; }
  catch { throw new Error("Owned legacy helper did not return its JSON contract"); }
}
async function expectRejectedStartup(owner: OwnedWeb, mode: "dev" | "standalone") {
  const result = await owner.start(mode).catch((error: unknown) => error);
  expect(result instanceof Error).toBe(true);
  const diagnostic = readOwnedCommandDiagnostics(result);
  expect(diagnostic !== undefined && (diagnostic.stderr + diagnostic.stdout).includes("ENTERPRISE_WEB_UNAVAILABLE")).toBe(true);
  // The owner has stopped the failed host. A Ready log alone never passed start().
  await expect(fetch(`${owner.baseURL}/api/auth/ok`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
}

describe("actual Next enterprise lifecycle", () => {
  it("builds unchanged product without DB/secrets, then reuses the assembly across dev bundles and real HMR", async ({ signal }) => {
    await withOwnedWeb(async owner => {
      let connections = 0;
      const sockets = new Set<import("node:net").Socket>();
      const observerServer = createServer(socket => { connections += 1; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.destroy(); });
      await new Promise<void>((resolve, reject) => { observerServer.once("error", reject); observerServer.listen(0, "127.0.0.1", resolve); });
      const address = observerServer.address();
      if (!address || typeof address === "string") throw new Error("Database observer did not bind");
      const original = { ...owner.env };
      try {
        owner.env.DATABASE_URL = `postgres://observed:synthetic@127.0.0.1:${address.port}/observed`;
        owner.env.AUTH_MODE = "enterprise";
        delete owner.env.BETTER_AUTH_SECRET;
        delete owner.env.EMAIL_PROVIDER;
        await owner.build(NEXT_BUILD_TIMEOUT); // No probe files or production source edits exist yet.
        expect(connections).toBe(0);
        console.info("FS93 Next: unchanged product build used zero DB connections and no required Auth secret");
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => observerServer.close(error => error ? reject(error) : resolve()));
        Object.assign(owner.env, original);
      }
      const observer = owner.createDatabaseObserver();
      await configureEnterprise(owner, observer);
      await installProbes(owner);
      const dev = await owner.start("dev");
      const app = await fetchProbe(owner);
      const pages = await fetchProbe(owner, true);
      expect(app.status).toBe(200); expect(pages).toEqual(app);
      expect(app.body.sameAuth).toBe(true);
      expect(await backendCount(observer)).toBe(1);
      const marker = `fs93-hmr-${randomUUID()}`;
      const authPath = "apps/web/lib/auth.ts";
      await owner.writeTestFile(authPath, (await readFile(path.join(owner.root, authPath), "utf8")) + `\n// ${marker}\n`);
      await expect.poll(async () => {
        await fetchProbe(owner); await fetchProbe(owner, true);
        return compiledMarker(path.join(owner.root, "apps/web/.next/dev/server"), marker);
      }, { timeout: 30_000, interval: 250 }).toBe(true);
      expect(await fetchProbe(owner)).toEqual(app);
      expect(await fetchProbe(owner, true)).toEqual(app);
      expect(await backendCount(observer)).toBe(1);
      console.info("FS93 Next: actual App/Pages HMR retained one Auth/Pool/backend");
      expect(await fetchProbe(owner, true, "close")).toEqual({ status: 200, body: { kind: "closed" } });
      expect((await fetchProbe(owner)).status).toBe(503);
      await dev.stop(); expectRealExit(await dev.exit);
      await expect.poll(() => backendCount(observer), { timeout: 3000 }).toBe(0);

      await owner.build(NEXT_BUILD_TIMEOUT); // This second build includes private test probes and is recorded separately.
      const standalone = await owner.start("standalone");
      const standaloneApp = await fetchProbe(owner);
      expect(standaloneApp.status).toBe(200);
      expect(await fetchProbe(owner, true)).toEqual(standaloneApp);
      expect(await fetchProbe(owner, true, "hold")).toEqual({ status: 200, body: { held: true } });
      expect(await fetchProbe(owner, true, "close")).toEqual({ status: 200, body: { kind: "cleanup-pending" } });
      expect((await fetchProbe(owner)).status).toBe(503);
      expect(await backendCount(observer)).toBeGreaterThan(0);
      await standalone.stop(); expectRealExit(await standalone.exit);
      await expect.poll(() => backendCount(observer), { timeout: 3000 }).toBe(0);
      console.info("FS93 Next: standalone cleanup-pending host exited and PG backend disappeared");

      // The same actual standalone artifact must reject a downgrade before HTTP readiness.
      owner.env.AUTH_MODE = "legacy";
      for (const key of Object.keys(owner.env)) if (key.startsWith("ENTERPRISE_")) delete owner.env[key];
      await expectRejectedStartup(owner, "standalone");
      await expect.poll(() => backendCount(observer), { timeout: 3000 }).toBe(0);
      owner.env.AUTH_MODE = "enterprise"; // Incomplete scope must also reject actual dev startup.
      await expectRejectedStartup(owner, "dev");
      await expect.poll(() => backendCount(observer), { timeout: 3000 }).toBe(0);
    }, signal);
  }, 420_000);

  it("keeps all three legacy mint children and the direct SSE consumer on their original assertions", async ({ signal }) => {
    await withOwnedWeb(async owner => {
      const first = childJson(await owner.run("pnpm", ["exec", "tsx", "apps/web/tests/e2e/helpers/mint-session-cli.ts"]));
      expect(typeof first.email === "string" && typeof first.password === "string" && Array.isArray(first.cookies) && first.cookies.length > 0).toBe(true);
      const second = childJson(await owner.run("pnpm", ["exec", "tsx", "apps/web/tests/e2e/helpers/mint-second-session-cli.ts", String(first.email), String(first.password)]));
      expect(Array.isArray(second.cookies) && second.cookies.length > 0).toBe(true);
      const reset = childJson(await owner.run("pnpm", ["exec", "tsx", "apps/web/tests/e2e/helpers/mint-reset-token-cli.ts"]));
      expect(typeof reset.email === "string" && typeof reset.token === "string" && reset.token.length > 0).toBe(true);
      await owner.run("pnpm", ["vitest", "run", "apps/web/tests/contract/mega-agent-sse.spec.ts", "--config", "apps/web/tests/config/enterprise.vitest.config.ts"]);
    }, signal);
  }, 240_000);
});
