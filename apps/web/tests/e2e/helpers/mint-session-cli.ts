/**
 * CLI: mint a better-auth session and print cookies as JSON for Playwright.
 * Usage (from repo root): pnpm exec tsx apps/web/tests/e2e/helpers/mint-session-cli.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
// Match Auth's static import so tsx closes the same database module instance.
import { closeDatabaseClient } from "@megaui/database";

function loadWebEnv(): void {
  const envPath = resolve(process.cwd(), "apps/web/.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseSetCookie(header: string) {
  const parts = header.split(";").map((p) => p.trim());
  const [nv, ...attrs] = parts;
  if (!nv) return null;
  const eq = nv.indexOf("=");
  if (eq <= 0) return null;
  const cookie: Record<string, unknown> = {
    name: nv.slice(0, eq),
    value: nv.slice(eq + 1),
    domain: "127.0.0.1",
    path: "/",
  };
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower === "httponly") cookie.httpOnly = true;
    else if (lower === "secure") cookie.secure = true;
    else if (lower.startsWith("path=")) cookie.path = attr.slice(5);
    else if (lower.startsWith("samesite=")) {
      const v = attr.slice(9).toLowerCase();
      cookie.sameSite =
        v === "lax"
          ? "Lax"
          : v === "strict"
            ? "Strict"
            : v === "none"
              ? "None"
              : undefined;
    }
  }
  return cookie;
}

async function main(): Promise<void> {
  loadWebEnv();
  const { getAuth } = await import("../../../lib/auth");
  const auth = getAuth();
  const email = `wa01-${randomUUID().slice(0, 8)}@example.com`;
  const password = "WA01-test-password-9x";

  await auth.api.signUpEmail({
    body: { email, password, name: "WA01 Tester" },
  });

  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });

  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const raw: string[] =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (raw.length === 0) {
    const single = response.headers.get("set-cookie");
    if (single) raw.push(single);
  }

  const cookies = raw.map(parseSetCookie).filter(Boolean);
  if (cookies.length === 0) {
    throw new Error("mint-session-cli: no Set-Cookie");
  }

  process.stdout.write(JSON.stringify({ email, password, cookies }));
}

async function run(): Promise<void> {
  try { await main(); }
  finally {
    // FIX-FS-02: do not wait for the Pool's idle timer or force process exit.
    await closeDatabaseClient();
  }
}

run().catch(() => {
  console.error("mint-session-cli: failed");
  process.exitCode = 1;
});
