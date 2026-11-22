// megaui-only (FS-93): Next awaits this public startup hook before serving requests.
// FSL-132: it first checks AUTH_MODE / AUTH_PROVIDER with `resolveAuthMode`, so a pair it
// refuses (including `maintenance` and `enterprise` without AUTH_PROVIDER, both
// `INVALID_AUTH_PROVIDER`) stops the startup. The old enterprise runtime is gone.
// FSL-158: in Feishu mode (AUTH_MODE=enterprise, AUTH_PROVIDER=feishu) it then checks the
// database runtime role (GC-15) before anything else touches the database: with
// NODE_ENV=production a role (or a role it may SET ROLE to) that is a superuser, has CREATEDB,
// or may CREATE in the current database or in one of its schemas, as well as privileges that
// cannot be read, refuses the startup with `DATABASE_ROLE_SCOPE_REJECTED`; in every other
// NODE_ENV it only prints `DATABASE_ROLE_SCOPE_WARNING`.
// FSL-150: in Feishu mode it then waits for the first run of the Feishu login code cleanup. It
// never installs a signal handler: shutdown keeps Next's default behaviour, and the cleanup timer
// is unref()ed so it never keeps the process alive.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertWebAuthMode, isFeishuWebMode, startFeishuWebRuntime } = await import("./lib/auth");
    assertWebAuthMode();
    if (isFeishuWebMode()) {
      const { checkRuntimeRoleScope, getPool } = await import("@megaui/database");
      // The pool is taken inside the query, so a missing DATABASE_URL counts as unreadable.
      await checkRuntimeRoleScope({ query: text => getPool().query(text) }, { nodeEnv: process.env.NODE_ENV });
      await startFeishuWebRuntime();
    }
  }
}
