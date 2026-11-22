import type { Database } from "@megaui/database";
import { createAclService, type AclService } from "../acl";
import { createCollabAuthzService, type CollabAuthzService } from "./authz";
import {
  createCollabTokenService,
  type CollabTokenConfig,
  type CollabTokenService,
} from "./token";

export {
  createCollabTokenService,
  type CollabTokenConfig,
  type CollabTokenEnv,
  type CollabTokenService,
  type MintedCollabToken,
} from "./token";
export {
  createCollabAuthzService,
  type CollabAuthzService,
  type CollabDocAccessReason,
  type CollabDocAccessResult,
} from "./authz";
export {
  createCollabInternalBridge,
  isCollabBridgeConfigured,
  resolveCollabInternalToken,
  resolveCollabInternalUrl,
  verifyInternalBridgeToken,
  type CollabBridgeEnv,
  type CollabInternalBridge,
  type CollabInternalBridgeConfig,
  type CollabInternalBridgeResult,
  type CollabInternalRetryConfig,
} from "./internal-bridge";

export interface CollabDomain {
  acl: AclService;
  token: CollabTokenService;
  authz: CollabAuthzService;
}

/** Wires the collab-domain services against one `Database` (EG-13). */
export function createCollabDomain(
  database: Database,
  tokenConfig?: CollabTokenConfig,
): CollabDomain {
  const acl = createAclService(database);
  const token = createCollabTokenService(tokenConfig);
  const authz = createCollabAuthzService(acl);
  return { acl, token, authz };
}
