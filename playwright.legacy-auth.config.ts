import { defineConfig } from "@playwright/test";

process.env.MEGAUI_FS89_MODE = "legacy";

export default defineConfig({
  testDir: "apps/web/tests/e2e",
  testMatch: "legacy-auth-fixture.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { trace: "off", baseURL: "http://127.0.0.1:0", launchOptions: { channel: "chrome" } },
});
