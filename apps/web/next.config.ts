import type { NextConfig } from "next";
import { env } from "./lib/env";

void env;

const siteName = process.env.MEGA_SITE_NAME?.trim() || "Mega";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_MEGA_SITE_NAME: siteName,
  },
  // Required for apps/web/Dockerfile `runner` target (SC-03): emits
  // .next/standalone so the production image ships a minimal server
  // bundle without the full node_modules tree.
  output: "standalone",
  // FS-19 rejects trailing-slash auth operation variants instead of letting
  // Next redirect them to an allowlisted canonical endpoint.
  skipTrailingSlashRedirect: true,
  transpilePackages: [
    "@megaui/auth",
    "@megaui/content",
    "@megaui/core",
    "@megaui/database",
    "@megaui/email",
    "@megaui/i18n",
    "@megaui/ui",
  ],
};

export default nextConfig;
