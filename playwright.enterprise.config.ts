import { defineConfig } from "@playwright/test";

process.env.MEGAUI_FS40_MODE = "enterprise";

export default defineConfig({
  testDir: "apps/web/tests/e2e",
  testMatch: /enterprise-(harness|offboarding|auth-policy|content-profile|social-profile|profile)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { trace: "off", baseURL: "http://127.0.0.1:0" },
});

