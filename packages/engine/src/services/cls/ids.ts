// megaui:libs/mega/services/store.ts@0ff3a9d (nextId)
//
// Single id-minting helper shared by cls.ts (EG-05) and the EG-06 attachment
// modules (checks/deps/revisions/inline) so every CL-domain row uses the
// same `${prefix}_${uuid}` shape.
import { randomUUID } from "node:crypto";

export function newClId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
