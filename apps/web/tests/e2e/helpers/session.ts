import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

/**
 * Mint session cookies via a tsx child process (avoids Playwright ESM import
 * issues with the Next/auth graph).
 */
export function mintSessionCookies(): {
  cookies: SessionCookie[];
  email: string;
  password: string;
} {
  const script = resolve(
    process.cwd(),
    "apps/web/tests/e2e/helpers/mint-session-cli.ts",
  );
  const stdout = execFileSync(
    "pnpm",
    ["exec", "tsx", script],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout.trim()) as {
    email: string;
    password: string;
    cookies: SessionCookie[];
  };
  if (!parsed.cookies?.length) {
    throw new Error("mintSessionCookies: empty cookie jar");
  }
  return parsed;
}

/** Sign in again for an existing user to obtain a second concurrent session. */
export function mintSecondSessionCookies(email: string, password: string): SessionCookie[] {
  const script = resolve(
    process.cwd(),
    "apps/web/tests/e2e/helpers/mint-second-session-cli.ts",
  );
  const stdout = execFileSync(
    "pnpm",
    ["exec", "tsx", script, email, password],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout.trim()) as { cookies: SessionCookie[] };
  if (!parsed.cookies?.length) {
    throw new Error("mintSecondSessionCookies: empty cookie jar");
  }
  return parsed.cookies;
}
