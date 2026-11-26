// megaui-only: mega2 admin-group membership of the signed-in user.
//
// mega2 is the single source of truth for who is an admin (`UserGroup::"admin"`
// in `/.mega_cedar.json`, GC-02). The check forwards the session cookie like the
// other mega2 user APIs and fails closed (GC-07): mega2 answering 401/403 means
// "not an admin"; any other failure propagates instead of granting access.
import { MegaForbiddenError, MegaUnauthorizedError } from "@megaui/engine";
import { z } from "zod";

import { getCommonResultJson } from "./write-client";

export const MEGA2_ADMIN_ME_PATH = "/api/v1/admin/me";

const isAdminResponseWireSchema = z.object({ is_admin: z.boolean() });

export interface Mega2AdminStatus {
  isAdmin: boolean;
}

export async function getMega2AdminStatus(
  headers?: HeadersInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mega2AdminStatus> {
  try {
    const response = await getCommonResultJson(
      MEGA2_ADMIN_ME_PATH,
      isAdminResponseWireSchema,
      headers ? { headers } : {},
      env,
    );
    return { isAdmin: response.is_admin };
  } catch (error) {
    if (error instanceof MegaUnauthorizedError || error instanceof MegaForbiddenError) {
      return { isAdmin: false };
    }
    throw error;
  }
}

/** Throws `MegaForbiddenError` unless mega2 confirms the caller is an admin. */
export async function requireMega2Admin(
  headers?: HeadersInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { isAdmin } = await getMega2AdminStatus(headers, env);
  if (!isAdmin) {
    throw new MegaForbiddenError("mega2 admin role required");
  }
}
