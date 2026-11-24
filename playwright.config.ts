import { defineConfig } from "@playwright/test";

const e2eBaseURL = (
  process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3000"
).replace(/\/$/, "");
const skipWebServer =
  process.env.E2E_SKIP_WEBSERVER === "1" ||
  process.env.E2E_SKIP_WEBSERVER === "true" ||
  e2eBaseURL !== "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "apps/web/tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: e2eBaseURL,
  },
  ...(skipWebServer
    ? {}
    : {
        webServer: {
          // Standalone output cannot use `next start`; run the emitted server with env loaded.
          // Static assets (.next/static) must be present in the standalone tree for
          // client-side hydration — copy them if missing before starting the server.
          command:
            "bash -lc 'set -a && [ -f apps/web/.env ] && . apps/web/.env; set +a; " +
            "export BETTER_AUTH_TRUSTED_ORIGINS=\"${BETTER_AUTH_TRUSTED_ORIGINS:+${BETTER_AUTH_TRUSTED_ORIGINS},}http://127.0.0.1:3000\"; " +
            "[ ! -d apps/web/.next/standalone/apps/web/.next/static ] && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static; " +
            "[ -d apps/web/public ] && [ ! -d apps/web/.next/standalone/apps/web/public ] && cp -r apps/web/public apps/web/.next/standalone/apps/web/public; " +
            "cd apps/web/.next/standalone/apps/web && PORT=3000 HOSTNAME=127.0.0.1 node server.js'",
          url: "http://127.0.0.1:3000",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }),
});
