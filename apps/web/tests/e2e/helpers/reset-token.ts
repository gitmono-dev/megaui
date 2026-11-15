import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { SessionCookie } from "./session";

export type ResetTokenResult = {
  email: string;
  token: string;
};

/**
 * Mint a password-reset token via a tsx child process (avoids Playwright ESM
 * import issues with the Next/auth/DB graph).
 *
 * Creates a fresh user, requests a reset, and reads the token from the
 * `verification` DB table.
 */
export function mintResetToken(): ResetTokenResult {
  const script = resolve(
    process.cwd(),
    "apps/web/tests/e2e/helpers/mint-reset-token-cli.ts",
  );
  const stdout = execFileSync("pnpm", ["exec", "tsx", script], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim()) as ResetTokenResult;
  if (!parsed.token) {
    throw new Error("mintResetToken: empty token");
  }
  return parsed;
}

// Re-export SessionCookie so e2e tests only need one import for helpers
export type { SessionCookie };
