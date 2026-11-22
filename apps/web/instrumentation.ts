// megaui-only (FS-93): Next awaits this public startup hook before serving requests.
// FSL-132: it first checks AUTH_MODE / AUTH_PROVIDER with `resolveAuthMode`, so a pair it
// refuses (including `maintenance` and `enterprise` without AUTH_PROVIDER, both
// `INVALID_AUTH_PROVIDER`) stops the startup. The old enterprise runtime is gone.
// FSL-150: in Feishu mode (AUTH_MODE=enterprise, AUTH_PROVIDER=feishu) it waits for the
// first run of the Feishu login code cleanup. It never installs a signal handler: shutdown
// keeps Next's default behaviour, and the cleanup timer is unref()ed so it never keeps the
// process alive.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertWebAuthMode, isFeishuWebMode, startFeishuWebRuntime } = await import("./lib/auth");
    assertWebAuthMode();
    if (isFeishuWebMode()) await startFeishuWebRuntime();
  }
}
