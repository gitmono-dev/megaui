// megaui:libs/mega/services/repos/releases-repo.ts@0ff3a9d
//
// megaui-only additions (EG-08 card AC: "asset key ownership (GC-07)").
//
// Upstream never persists asset metadata at all ("Assets are not persisted in v1"),
// so there is no reference implementation to port here. WA-19 (out of
// scope for this card) owns the actual object-storage upload/presign path;
// this module only validates that a caller-supplied *key reference* is
// well-formed and scoped to the release it is being attached to. It never
// talks to `@megaui/storage` or any storage backend.
//
// Mirrors the shape of `@megaui/storage`'s `assertKeyOwnedByUser` (userId-
// scoped `{avatars|attachments}/{userId}/…` prefixes) but scoped by
// `releaseId` instead — release assets are workspace-shared, not
// per-user-owned, so the owning entity is the release, not the actor.
import { MegaBadRequestError, MegaForbiddenError } from "../../errors";

const RELEASE_ASSET_KEY_PREFIX = "releases";

function assertSafeSegment(segment: string, label: string): void {
  if (!segment || segment.includes("/") || segment.includes("\\")) {
    throw new MegaBadRequestError(`${label} must be a non-empty single path segment`);
  }
  if (segment === "." || segment === "..") {
    throw new MegaBadRequestError(`${label} must not be '.' or '..'`);
  }
  if (segment.includes("..")) {
    throw new MegaBadRequestError(`${label} must not contain '..'`);
  }
}

function assertSafeFileName(fileName: string): void {
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) {
    throw new MegaBadRequestError("fileName must be a non-empty single path segment");
  }
  if (fileName.includes("..")) {
    throw new MegaBadRequestError("fileName must not contain '..'");
  }
}

/** Builds the owned object key for a release asset: `releases/{releaseId}/{fileName}`. */
export function buildReleaseAssetKey(input: { releaseId: string; fileName: string }): string {
  assertSafeSegment(input.releaseId, "releaseId");
  assertSafeFileName(input.fileName);
  return `${RELEASE_ASSET_KEY_PREFIX}/${input.releaseId}/${input.fileName}`;
}

/**
 * Fail-closed (GC-07) ownership check: rejects absolute paths, path
 * traversal, and any key outside the `releases/{releaseId}/` namespace —
 * so a caller cannot attach another release's asset key (or an unrelated
 * purpose's object, e.g. `avatars/…`) to this release. Malformed input
 * (empty/traversal segments) is a `MegaBadRequestError`; a well-formed key
 * that resolves outside the owned prefix is a `MegaForbiddenError`.
 */
export function assertReleaseAssetKeyOwnership(input: { key: string; releaseId: string }): void {
  assertSafeSegment(input.releaseId, "releaseId");
  const { key } = input;
  if (!key || key.startsWith("/") || key.includes("\\")) {
    throw new MegaBadRequestError("Asset key must be a relative object path");
  }
  const segments = key.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new MegaBadRequestError(`Asset key contains empty or '.'/'..' segments: ${key}`);
  }

  const expectedPrefix = `${RELEASE_ASSET_KEY_PREFIX}/${input.releaseId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new MegaForbiddenError(`Asset key is outside the owned prefix for this release: ${expectedPrefix}`);
  }
  if (key.length <= expectedPrefix.length) {
    throw new MegaBadRequestError("Asset key must include a file name under the owned release prefix");
  }
}
