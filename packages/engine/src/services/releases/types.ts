// megaui:libs/mega/services/repos/releases-repo.ts@0ff3a9d (DraftReleaseInput shape)
//
// Diff vs upstream (GC-03, registered on the EG-08 task card):
// - `targetSha` is a required caller input, not derived from
//   `getStore().workspace.headSha` — this card has no mega2 commit
//   integration (that is EG-11, not a dependency of EG-08).
// - `publishRelease` / `AddReleaseAssetInput` are megaui-only: upstream
//   never persists assets (`releases-repo.ts` "Assets are not persisted in
//   v1") and has no draft→publish mutation at all (the tags page only ever
//   creates drafts). This card's AC requires both.
// - `EngineRelease`/`EngineReleaseAsset` extend `@megaui/core`'s
//   `Release`/`ReleaseAsset` with a `key` field so the object-storage key
//   reference survives the round trip; `ReleaseAsset.downloadUrl` is not
//   extended in `@megaui/core` (out of this card's write set), so
//   `downloadUrl` currently mirrors the raw key until WA-19 wires real
//   upload + signed-URL resolution (out of scope here, key metadata only).
import type { Release, ReleaseAsset } from "@megaui/core";
import type { PaginationInput } from "../../context";

export interface EngineReleaseAsset extends ReleaseAsset {
  /** Object storage key metadata only — WA-19 owns the binary upload path. */
  key: string;
}

export interface EngineRelease extends Release {
  assets: readonly EngineReleaseAsset[];
}

export interface CreateDraftReleaseInput {
  tag: string;
  title: string;
  /** Target commit sha (short or full) — no mega2 resolution in this card. */
  targetSha: string;
  /** One entry per note; plain text or Lexical editor-state JSON (comment-body parity). */
  notes?: readonly string[];
  prerelease?: boolean;
  major?: boolean;
}

export interface AddReleaseAssetInput {
  name: string;
  /** Object storage key reference (GC-07 ownership-checked, see `asset-key.ts`). */
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface ListReleasesInput {
  pagination?: PaginationInput;
}

export interface ListReleasesResult {
  items: EngineRelease[];
  total: number;
  offset: number;
  limit: number;
}
