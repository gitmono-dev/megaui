// megaui-only (FS-92): let Next generate the App/Pages compatibility declarations.
// This CMD-05 contract uses actual Node HTTP and Next processes, never a browser.
import { access, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OwnedWeb, withOwnedWeb, readOwnedCommandDiagnostics } from "../helpers/owned-web";

const probe = `import type { NextApiRequest, NextApiResponse } from "next";
export default function probe(request: NextApiRequest, response: NextApiResponse) {
  response.status(200).json({ marker: "owned-navigation-probe", peer: request.socket.remoteAddress });
}
`;

async function checkRoutes(owner: OwnedWeb) {
  const probeResponse = await fetch(`${owner.baseURL}/api/auth/owned-navigation-probe`, { signal: AbortSignal.timeout(10_000) });
  expect(probeResponse.status).toBe(200);
  expect(await probeResponse.json()).toEqual({ marker: "owned-navigation-probe", peer: "127.0.0.1" });
  const oldAuth = await fetch(`${owner.baseURL}/api/auth/ok`, { signal: AbortSignal.timeout(10_000) });
  expect(oldAuth.status).toBe(200);
  expect(await oldAuth.json()).toEqual({ ok: true });
}

describe("actual Next navigation compatibility", () => {
  it("generates nullable navigation types and builds/runs the six real components", async ({ signal }) => {
    let directory = "";
    await withOwnedWeb(async (owner) => {
      directory = owner.directory;
      await expect(access(path.join(owner.root, "apps/web/.env"))).rejects.toThrow();
      await expect(access(path.join(owner.root, ".libra"))).rejects.toThrow();
      const resolvedCore = await realpath(path.join(owner.root, "apps/web/node_modules/@megaui/core"));
      expect(resolvedCore).toBe(path.join(await realpath(owner.root), "packages/core"));
      expect(owner.env.NODE_OPTIONS).toBeUndefined();
      expect(owner.env.PGOPTIONS).toBeUndefined();
      await owner.writeTestFile("apps/web/pages/api/auth/owned-navigation-probe.ts", probe);
      const dev = await owner.start("dev");
      await checkRoutes(owner);
      await dev.stop();
      await owner.build();
      const generated = await readFile(path.join(owner.root, "apps/web/next-env.d.ts"), "utf8");
      expect(generated).toContain("next/navigation-types/compat/navigation");
      const standalone = await owner.start("standalone");
      await checkRoutes(owner);
      await standalone.stop();
    }, signal);
    await expect(access(directory)).rejects.toThrow();
  }, 300_000);

  it("keeps a foreign port owner intact and cleans up after failed startup/commands", async ({ signal }) => {
    const cancellation = new AbortController();
    const combinedSignal = AbortSignal.any([signal, cancellation.signal]);
    const owner = await OwnedWeb.create(combinedSignal);
    const abort = () => { void owner.close().catch(() => undefined); };
    combinedSignal.addEventListener("abort", abort, { once: true });
    const foreign = createServer((_request, response) => response.end(JSON.stringify({ ok: true })));
    let foreignHits = 0;
    foreign.on("request", () => { foreignHits += 1; });
    try {
      await new Promise<void>((resolve, reject) => {
        foreign.once("error", reject);
        foreign.listen(owner.port, "127.0.0.1", resolve);
      });
      await expect(owner.start("dev")).rejects.toThrow("failed to bind");
      expect(foreignHits).toBe(0); // A foreign /api/auth/ok must not satisfy readiness.
      expect((await fetch(owner.baseURL)).status).toBe(200);
      const failed = await owner.run(process.execPath, ["-e", "console.log('OWNED_PRIVATE_DIAGNOSTIC_MARKER'); process.exit(7)"]).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(String(failed)).toContain("exit 7");
      expect(Object.getOwnPropertyNames(failed)).not.toContain("result");
      expect(JSON.stringify(failed)).not.toContain("OWNED_PRIVATE_DIAGNOSTIC_MARKER");
      expect(readOwnedCommandDiagnostics(failed)?.stdout).toContain("OWNED_PRIVATE_DIAGNOSTIC_MARKER");
      await expect(owner.run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], 1_000)).rejects.toThrow("deadline");
      await expect(owner.writeTestFile("../outside.ts", "no")).rejects.toThrow("Invalid owned test path");
      await expect(owner.writeTestFile("apps/web/.env", "no")).rejects.toThrow("Invalid owned test path");
      const running = owner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      cancellation.abort();
      await expect(running).rejects.toThrow("Owned Web command failed");
    } finally {
      combinedSignal.removeEventListener("abort", abort);
      const cleanup = owner.close();
      const repeatedCleanup = owner.close();
      // Release both owners even if one cleanup fails; the test must report either.
      const results = await Promise.allSettled([
        cleanup,
        new Promise<void>((resolve, reject) => foreign.close((error) => error ? reject(error) : resolve())),
      ]);
      const failures = results.filter((result) => result.status === "rejected");
      expect(failures).toEqual([]);
      expect(repeatedCleanup).toBe(cleanup);
    }
    await expect(access(owner.directory)).rejects.toThrow();
  }, 180_000);
});
