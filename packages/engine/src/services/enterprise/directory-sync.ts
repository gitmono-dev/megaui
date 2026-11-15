// megaui-only (FS-08): the directory reconciliation has no upstream counterpart.
/**
 * FS-08：目录对账与新鲜度失效。
 *
 * The worker reconciles the authorized scope every five minutes. Only a
 * complete snapshot of the requested scope reaches the store. The store owns
 * the atomic generation compare-and-set, so overlapping runs can never move a
 * watermark backwards or let a stale response restore an active identity.
 */
import type {
  DirectorySnapshotApplyInput,
  DirectorySnapshotApplyResult,
  DirectoryStoredIdentity,
} from "@megaui/database";

import {
  isDirectoryMemberActive,
  scopeHashOf,
  type DirectoryScope,
  type DirectorySnapshot,
} from "./feishu/directory";

/** The reconciliation period: five minutes. */
export const DIRECTORY_SYNC_PERIOD_MS = 5 * 60 * 1000;
/** An identity older than this can not obtain eligibility. */
export const DIRECTORY_FRESHNESS_LIMIT_MS = 15 * 60 * 1000;

export type DirectoryReconcileOutcome =
  | {
      kind: "applied";
      missing: DirectoryStoredIdentity[];
      outOfScope: DirectoryStoredIdentity[];
    }
  | { kind: "skipped"; reason: "incomplete" | "scope_changed" | "stale_generation" };

/** The atomic persistence port used by the reconciler. */
export interface DirectoryReconcileStore {
  applyCompleteSnapshot(input: DirectorySnapshotApplyInput): Promise<DirectorySnapshotApplyResult>;
}

/** True when the observation is fresh enough to grant eligibility. */
export function isDirectoryFresh(observedAt: number, now: number): boolean {
  return now - observedAt <= DIRECTORY_FRESHNESS_LIMIT_MS;
}

/** True when an incoming generation is newer than a known watermark. */
export function mayAdvanceGeneration(
  current: number | undefined,
  incoming: number,
): boolean {
  return current === undefined || incoming > current;
}

/** Returns the previously tracked identities absent from the new snapshot. */
function selectAbsent(
  previous: readonly DirectoryStoredIdentity[],
  next: DirectorySnapshot,
): DirectoryStoredIdentity[] {
  const present = new Set(next.members.map((member) => member.openId));
  return previous.filter((identity) => !present.has(identity.openId));
}

/**
 * Returns identities excluded by an explicit authorized-scope transition.
 *
 * The previous identities come from the old scope watermark. A real provider
 * snapshot for the narrowed scope omits excluded identities, so filtering the
 * new snapshot itself would lose exactly the identities that must be marked
 * `out_of_scope`.
 */
export function selectOutOfScope(
  previous: readonly DirectoryStoredIdentity[],
  next: DirectorySnapshot,
): DirectoryStoredIdentity[] {
  return selectAbsent(previous, next);
}

/** The next state of an identity after an authoritative directory result. */
export function nextIdentityState(input: {
  localBan: boolean;
  directoryActive: boolean;
  fresh: boolean;
  advanced: boolean;
}): "active" | "inactive" | "out_of_scope" | "stale" {
  if (input.localBan) return "inactive";
  if (!input.advanced) return input.directoryActive ? "stale" : "inactive";
  if (!input.fresh) return "stale";
  return input.directoryActive ? "active" : "inactive";
}

export interface DirectoryReconcilerOptions {
  scope: DirectoryScope;
  /** Set only for the first run after an authorized-scope change. */
  previousScope?: DirectoryScope;
  store: DirectoryReconcileStore;
  readSnapshot: () => Promise<DirectorySnapshot>;
  now?: () => number;
}

function previousScopeHashOf(
  current: DirectoryScope,
  previous: DirectoryScope | undefined,
): string | undefined {
  if (!previous) return undefined;
  if (previous.tenantKey !== current.tenantKey || previous.appId !== current.appId) {
    throw new Error(
      "[@megaui/engine] a directory scope transition must keep the same tenant and app",
    );
  }
  const previousHash = scopeHashOf(previous);
  const currentHash = scopeHashOf(current);
  return previousHash === currentHash ? undefined : previousHash;
}

/** Runs one reconciliation of the authorized scope. */
export async function reconcileDirectory(
  options: DirectoryReconcilerOptions,
): Promise<DirectoryReconcileOutcome> {
  const next = await options.readSnapshot();
  const scopeHash = scopeHashOf(options.scope);
  if (!next.complete) {
    // A failed page never enters the transaction and therefore keeps the
    // previous complete snapshot and watermark intact.
    return { kind: "skipped", reason: "incomplete" };
  }
  if (next.scopeHash !== scopeHash) {
    return { kind: "skipped", reason: "scope_changed" };
  }

  const previousScopeHash = previousScopeHashOf(options.scope, options.previousScope);
  // A complete provider snapshot may still list frozen, resigned, or exited
  // members. Persist the snapshot itself, but only active four-state members
  // advance an identity watermark for authentication.
  const activeMemberOpenIds = next.members
    .filter(isDirectoryMemberActive)
    .map((member) => member.openId);
  const result = await options.store.applyCompleteSnapshot({
    tenantKey: options.scope.tenantKey,
    appId: options.scope.appId,
    scopeHash,
    previousScopeHash,
    generation: next.generation,
    observedAt: new Date((options.now ?? Date.now)()),
    memberOpenIds: next.members.map((member) => member.openId),
    watermarkOpenIds: activeMemberOpenIds,
  });
  if (!result.applied) {
    return { kind: "skipped", reason: "stale_generation" };
  }

  const absent = selectAbsent(result.previous, next);
  if (previousScopeHash) {
    // During a scope transition an absent identity is conservatively classified
    // as out-of-scope; it must not be interpreted as a departed member.
    return { kind: "applied", missing: [], outOfScope: absent };
  }
  return { kind: "applied", missing: absent, outOfScope: [] };
}
