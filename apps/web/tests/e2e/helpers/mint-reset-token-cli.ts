/**
 * CLI: mint a password-reset token for e2e testing.
 * Signs up a fresh user, requests a password reset, then reads the raw token
 * from the `verification` DB table.
 *
 * Usage (from repo root):
 *   pnpm exec tsx apps/web/tests/e2e/helpers/mint-reset-token-cli.ts
 *
 * Prints JSON { email, token } to stdout.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

async function main(): Promise<void> {
  loadWebEnv();

  const { getAuth } = await import("../../../lib/auth");
  const { getDb, verification } = await import("@megaui/database");
  const { desc, eq } = await import("drizzle-orm");

  const auth = getAuth();
  const db = getDb();
  const email = `wa02-reset-${randomUUID().slice(0, 8)}@example.com`;
  const password = "WA02-test-pwd-9x!";

  // Create the user
  const signUpResult = await auth.api.signUpEmail({
    body: { email, password, name: "WA02 Reset Tester" },
  });
  const userId = signUpResult?.user?.id;
  if (!userId) {
    console.error("mint-reset-token-cli: signUpEmail returned no user id");
    process.exit(1);
  }

  // Request a password reset (stores token in verification table)
  await auth.api.requestPasswordReset({
    body: { email, redirectTo: "/reset-password" },
  });

  // Brief pause to ensure DB write is committed
  await new Promise((r) => setTimeout(r, 150));

  // better-auth 1.4.x stores the reset token as
  //   identifier = `reset-password:<token>`, value = <userId>
  // (not identifier = email). Match on the identifier prefix and the user
  // id, then strip the prefix to recover the raw token.
  const rows = await db
    .select({ identifier: verification.identifier })
    .from(verification)
    .where(eq(verification.value, userId))
    .orderBy(desc(verification.createdAt))
    .limit(1);

  const identifier = rows[0]?.identifier;
  if (!identifier) {
    console.error(
      "mint-reset-token-cli: no verification record found for",
      email,
    );
    process.exit(1);
  }
  const token = identifier.slice("reset-password:".length);
  if (!token) {
    console.error("mint-reset-token-cli: empty token parsed from", identifier);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ email, token }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
