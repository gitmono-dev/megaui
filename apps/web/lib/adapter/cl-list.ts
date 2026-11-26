import type { Filter } from "@megaui/core";
import { getDb } from "@megaui/database";
import { MegaUnauthorizedError } from "@megaui/engine";

import { getClsDomain } from "@/lib/engine";
import { isMega2ClBackendEnabled, listLiveMega2Cls } from "./mega2/cl-projection";

export function listWorkspaceCLs(filter: Filter, actorUserId: string | null, headers: Headers) {
  if (!actorUserId) throw new MegaUnauthorizedError("Authentication required");
  return isMega2ClBackendEnabled()
    ? listLiveMega2Cls(getDb(), filter, { headers, actorUserId })
    : getClsDomain().cls.listCLs(filter, actorUserId);
}
