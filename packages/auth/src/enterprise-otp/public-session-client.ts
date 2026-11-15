// megaui-only (FS-39): browser client plugin for the public enterprise session projection.
import type { BetterAuthClientPlugin } from "better-auth";

/** Browser-only adapter for the public enterprise session projection. */
export function createEnterpriseSessionClientPlugin() {
  return {
    id: "megaui-enterprise-public-session-client",
    version: "1",
    pathMethods: { "/enterprise/session": "GET" as const },
    fetchPlugins: [{
      id: "megaui-enterprise-public-session-route",
      name: "megaui enterprise public session route",
      hooks: {
        onRequest(context) {
          const url = new URL(context.url.toString());
          if (url.pathname.endsWith("/get-session")) {
            url.pathname = `${url.pathname.slice(0, -"/get-session".length)}/enterprise/session`;
            return { ...context, url };
          }
          return undefined;
        },
      },
    }],
  } satisfies BetterAuthClientPlugin;
}
