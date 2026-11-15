import { getDb } from "@megaui/database";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { env } from "@/lib/env";

// megaui:apps/next-app/app/api/health/route.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-01):
// - Application name from `MEGAUI_APP_NAME` (no hardcoded `next-app`).
// - Omits memory/system/pid dump; only DB check + sanitized timings
//   (never echoes connection strings).

const noStoreHeaders = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

/**
 * Health check — reports DB connectivity without leaking connection strings.
 */
export async function GET() {
  const startTime = Date.now();
  let dbStatus: "healthy" | "unhealthy" = "healthy";
  let dbResponseTime = 0;

  try {
    const dbStart = Date.now();
    await getDb().select({ value: sql`1` });
    dbResponseTime = Date.now() - dbStart;
  } catch {
    dbStatus = "unhealthy";
  }

  const healthy = dbStatus === "healthy";
  const body = {
    status: healthy ? "healthy" : "unhealthy",
    timestamp: new Date().toISOString(),
    application: env.MEGAUI_APP_NAME,
    checks: {
      database: {
        status: dbStatus,
        responseTimeMs: dbResponseTime,
      },
    },
    responseTimeMs: Date.now() - startTime,
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: noStoreHeaders,
  });
}

export async function HEAD() {
  try {
    await getDb().select({ value: sql`1` });
    return new Response(null, { status: 200, headers: noStoreHeaders });
  } catch {
    return new Response(null, { status: 503, headers: noStoreHeaders });
  }
}
