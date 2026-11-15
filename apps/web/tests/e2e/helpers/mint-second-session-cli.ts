/**
 * CLI: sign in an existing user and print session cookies as JSON.
 * Usage: pnpm exec tsx apps/web/tests/e2e/helpers/mint-second-session-cli.ts <email> <password>
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
        v === "lax" ? "Lax" : v === "strict" ? "Strict" : v === "none" ? "None" : undefined;
    }
  }
  return cookie;
}

async function main(): Promise<void> {
  loadWebEnv();
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error("usage: mint-second-session-cli.ts <email> <password>");
    process.exit(1);
  }

  const { getAuth } = await import("../../../lib/auth");
  const auth = getAuth();
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });

  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw: string[] =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (raw.length === 0) {
    const single = response.headers.get("set-cookie");
    if (single) raw.push(single);
  }

  const cookies = raw.map(parseSetCookie).filter(Boolean);
  if (cookies.length === 0) {
    console.error("mint-second-session-cli: no Set-Cookie");
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ cookies }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
