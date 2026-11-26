// megaui:libs/mega/services/cls.ts@0ff3a9d (TRANSITIONS / mergeStateFor / mockTransitionCLState guards)
// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (same TRANSITIONS/mergeStateFor duplicated for the DB backend)
//
// Diff vs upstream (registered on the EG-05 task card):
// - Upstream `transitionCLState(number, target)` takes no actor and never
//   checks permission — any caller can drive any CL through the matrix.
//   megaui is fail-closed by default (GC-07): only the CL author may drive
//   a state transition. `decideCLTransition` is the single permission×state
//   decision surface (card AC2); it is a pure function so the full matrix
//   (3 actor roles × 6 states × 6 targets) is unit-testable without a
//   database.
// - The two upstream copies of `TRANSITIONS` / `mergeStateFor` (mock backend
//   in `cls.ts`, DB backend in `cls-repo.ts`) collapse into this single
//   module (GC-02 single source of truth) — `cls.ts` never duplicates the
//   matrix.
import type { CL, CLMergeState, CLState } from "@megaui/core";
import { MegaConflictError, MegaForbiddenError, MegaUnauthorizedError } from "../../errors";

/** The canonical CL state machine (unchanged from upstream). */
export const CL_STATE_TRANSITIONS: Readonly<Record<CLState, readonly CLState[]>> = {
  wip: ["ready", "closed"],
  ready: ["wip", "queued", "conflicts", "closed"],
  queued: ["ready", "merged", "conflicts"],
  conflicts: ["wip", "ready", "closed"],
  merged: [],
  closed: [],
};

/** Derives the `merge` chip for a target state (unchanged from upstream). */
export function mergeStateForTransition(target: CLState, cl: Pick<CL, "reviewers">): CLMergeState {
  if (target === "queued") return "in-queue";
  if (target === "merged") return "merged";
  if (target === "conflicts") return "rebase-needed";
  // Empty reviewers: Array#every is vacuously true → queue-ready (mock parity).
  if (target === "ready") {
    return cl.reviewers.every((reviewer) => reviewer.verdict === "approved") ? "queue-ready" : "needs-review";
  }
  return "needs-review";
}

/** The actor axis of the EG-05 AC2 permission×state decision matrix. */
export type CLTransitionActorRole = "author" | "stranger" | "anonymous";

export function resolveCLTransitionActorRole(
  cl: Pick<CL, "author">,
  actorUserId: string | null | undefined,
): CLTransitionActorRole {
  const trimmed = actorUserId?.trim();
  if (!trimmed) return "anonymous";
  return trimmed === cl.author.id ? "author" : "stranger";
}

export type CLTransitionDenialReason =
  | "unauthenticated"
  | "forbidden"
  | "illegal-transition"
  | "queue-not-ready";

export interface CLTransitionDecision {
  allow: boolean;
  role: CLTransitionActorRole;
  fromState: CLState;
  /** `true` when `target === fromState` — a same-state call the service treats as a no-op. */
  noop: boolean;
  reason?: CLTransitionDenialReason;
}

/**
 * Pure permission×state decision surface (EG-05 AC2). Never touches the
 * database — `createClsService.transitionCLState` is the only caller that
 * loads a `CL` row and turns a denial into a thrown `Mega*Error`.
 */
export function decideCLTransition(
  cl: Pick<CL, "author" | "state" | "merge" | "reviewers">,
  target: CLState,
  actorUserId: string | null | undefined,
): CLTransitionDecision {
  const role = resolveCLTransitionActorRole(cl, actorUserId);
  const fromState = cl.state;

  if (role === "anonymous") {
    return { allow: false, role, fromState, noop: false, reason: "unauthenticated" };
  }
  if (role === "stranger") {
    return { allow: false, role, fromState, noop: false, reason: "forbidden" };
  }
  if (fromState === target) {
    return { allow: true, role, fromState, noop: true };
  }
  if (!CL_STATE_TRANSITIONS[fromState].includes(target)) {
    return { allow: false, role, fromState, noop: false, reason: "illegal-transition" };
  }
  if (target === "queued" && cl.merge !== "queue-ready") {
    return { allow: false, role, fromState, noop: false, reason: "queue-not-ready" };
  }
  return { allow: true, role, fromState, noop: false };
}

/** Throws the matching fail-closed `Mega*Error` for a denied decision; no-op otherwise. */
export function assertCLTransitionAllowed(
  decision: CLTransitionDecision,
  _number: number,
  target: CLState,
): void {
  if (decision.allow) return;
  switch (decision.reason) {
    case "unauthenticated":
      throw new MegaUnauthorizedError("A signed-in session is required");
    case "forbidden":
      throw new MegaForbiddenError("Only the CL author can transition its state");
    case "queue-not-ready":
      throw new MegaConflictError("Cannot queue this CL while review is still required");
    default:
      throw new MegaConflictError(`Cannot transition this CL from ${decision.fromState} to ${target}`);
  }
}
