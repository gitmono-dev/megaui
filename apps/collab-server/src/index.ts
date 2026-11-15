/**
 * collab-server CLI entry (CS-01): Hocuspocus on MEGA_COLLAB_PORT (default 7002).
 */

export type { CollabServerHandle, CollabServerOptions } from "./server.js";

async function main(): Promise<void> {
  const { createCollabServer } = await import("./server.js");
  const handle = createCollabServer();

  const shutdown = async (signal: string) => {
    console.log(`[collab-server] ${signal} received, shutting down…`);
    try {
      await handle.destroy();
    } catch (error) {
      console.error("[collab-server] shutdown error", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await handle.listen();
}

main().catch((error) => {
  console.error("[collab-server] fatal", error);
  process.exit(1);
});
