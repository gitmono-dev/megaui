import { defineConfig } from "@playwright/test";

/**
 * FSL-129: the Feishu login E2E (`feishu-login-*.spec.ts`).
 *
 * No `webServer` and no external `E2E_BASE_URL`: every spec provisions its own one-shot
 * PostgreSQL, Feishu Mock process and Feishu-mode `next dev` Web through
 * `apps/web/tests/e2e/helpers/feishu-login-harness.ts`, and releases them on success and
 * failure. One worker, serial: each harness owns a full Web process.
 */
export default defineConfig({
  testDir: "apps/web/tests/e2e",
  testMatch: /feishu-login-[a-z-]+\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
