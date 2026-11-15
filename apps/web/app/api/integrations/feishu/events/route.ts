// megaui-only (FS-09): authenticated Feishu callback ingress.
import { getPool } from "@megaui/database";
import { acceptVerifiedEvent } from "@megaui/engine";

import {
  FeishuCallbackError,
  getFeishuEventConfig,
  readBoundedFeishuBody,
  verifyFeishuCallback,
} from "../../../../../lib/feishu-events";

export const runtime = "nodejs";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * The only anonymous callback verb. Every verification step completes before
 * FS-66 receives the projected event, and the response waits for its database
 * transaction to commit.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const config = getFeishuEventConfig();
    const body = await readBoundedFeishuBody(request);
    const callback = verifyFeishuCallback({
      headers: request.headers,
      body,
      config,
    });

    if (callback.kind === "url_verification") {
      return json({ challenge: callback.challenge });
    }
    if (callback.kind === "event") {
      await acceptVerifiedEvent(getPool(), callback.event);
    }
    return json({ ok: true });
  } catch (error) {
    if (error instanceof FeishuCallbackError) {
      return json({ error: { code: error.code } }, error.status);
    }
    return json({ error: { code: "callback_internal_error" } }, 500);
  }
}
