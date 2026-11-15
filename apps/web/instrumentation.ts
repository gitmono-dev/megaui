// megaui-only (FS-93): Next awaits this public startup hook before serving requests.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeEnterpriseWebRuntime } = await import("./lib/auth");
    await initializeEnterpriseWebRuntime();
  }
}
