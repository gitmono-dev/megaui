import type { Database } from "@megaui/database";
import { createReleasesService, type ReleasesService } from "./releases";

export { createReleasesService, type ReleasesService } from "./releases";
export { buildReleaseAssetKey, assertReleaseAssetKeyOwnership } from "./asset-key";
export type {
  AddReleaseAssetInput,
  CreateDraftReleaseInput,
  EngineRelease,
  EngineReleaseAsset,
  ListReleasesInput,
  ListReleasesResult,
} from "./types";

export interface ReleasesDomain {
  releases: ReleasesService;
}

/** Wires the releases-domain service against one `Database` (EG-08). */
export function createReleasesDomain(database: Database): ReleasesDomain {
  return { releases: createReleasesService(database) };
}
