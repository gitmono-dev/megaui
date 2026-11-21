// megaui-only (FS-93): Next awaits this public startup hook before serving requests.
// FSL-150: in Feishu mode (AUTH_MODE=enterprise, AUTH_PROVIDER=feishu) it waits for the
// first run of the Feishu login code cleanup instead of the enterprise runtime. It never
// installs a signal handler: shutdown keeps Next's default behaviour, and the cleanup timer
// is unref()ed so it never keeps the process alive.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeEnterpriseWebRuntime, isFeishuWebMode, startFeishuWebRuntime } = await import("./lib/auth");
    if (isFeishuWebMode()) {
      await startFeishuWebRuntime();
      return;
    }
    await initializeEnterpriseWebRuntime();
  }
}
