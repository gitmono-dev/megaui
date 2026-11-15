import { defineConfig } from "@playwright/test";

/**
 * FSM-05：Mock 自身的 API-only E2E。
 *
 * 只收集 feishu-mock.spec.ts，不启动网站、浏览器或数据库；trace、video 与
 * screenshot 全部关闭。
 */
export default defineConfig({
  testDir: "apps/web/tests/e2e",
  testMatch: /feishu-mock\.spec\.ts/,
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: {
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
