// megaui-only (FS-73): the sole Node entry for enterprise pairing requests.
import type { NextApiRequest, NextApiResponse } from "next";

import { prepareWebAuth } from "@/lib/auth";
import { getReadyWebAssembly } from "@/lib/enterprise-runtime";
import { handleEnterpriseRequest } from "@/lib/enterprise-transport";

export const config = { api: { bodyParser: false } };

function unavailable(res: NextApiResponse): void {
  if (res.headersSent || res.destroyed) return;
  res.status(503).setHeader("content-type", "application/json; charset=utf-8").setHeader("cache-control", "no-store").end(JSON.stringify({ error: "UNAVAILABLE" }));
}

export default async function enterprisePairingRequest(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  try {
    const assembly = getReadyWebAssembly(prepareWebAuth);
    if (!assembly?.origin || assembly.pairing.kind !== "enabled") {
      unavailable(res);
      return;
    }
    await handleEnterpriseRequest({
      req,
      res,
      origin: assembly.origin,
      handler: (request) => assembly.auth.handler(request),
    });
  } catch {
    unavailable(res);
  }
}
