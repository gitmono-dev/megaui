import { describe, expect, it } from "vitest";
import type { CL, CLReviewer, CLState } from "@megaui/core";
import { MegaConflictError, MegaForbiddenError, MegaUnauthorizedError } from "../../errors";
import {
  CL_STATE_TRANSITIONS,
  assertCLTransitionAllowed,
  decideCLTransition,
  mergeStateForTransition,
  resolveCLTransitionActorRole,
} from "./state";

const ALL_STATES: readonly CLState[] = ["wip", "ready", "queued", "conflicts", "merged", "closed"];

type CLSlice = Pick<CL, "author" | "state" | "merge" | "reviewers">;

function makeCL(overrides: Partial<CLSlice> = {}): CLSlice {
  return {
    author: { id: "usr_author", username: "author", displayName: "Author", avatarInitials: "AU" },
    state: "wip",
    merge: "needs-review",
    reviewers: [],
    ...overrides,
  };
}

function reviewer(id: string, verdict: CLReviewer["verdict"]): CLReviewer {
  return { user: { id, username: id, displayName: id, avatarInitials: "RV" }, verdict };
}

describe("resolveCLTransitionActorRole", () => {
  it("classifies author / stranger / anonymous (trimmed, null, undefined, blank)", () => {
    const cl = makeCL();
    expect(resolveCLTransitionActorRole(cl, "usr_author")).toBe("author");
    expect(resolveCLTransitionActorRole(cl, " usr_author ")).toBe("author");
    expect(resolveCLTransitionActorRole(cl, "usr_other")).toBe("stranger");
    expect(resolveCLTransitionActorRole(cl, null)).toBe("anonymous");
    expect(resolveCLTransitionActorRole(cl, undefined)).toBe("anonymous");
    expect(resolveCLTransitionActorRole(cl, "   ")).toBe("anonymous");
  });
});

describe("decideCLTransition — permission × state decision matrix (EG-05 AC2)", () => {
  it("denies every transition for an anonymous actor, regardless of state", () => {
    for (const state of ALL_STATES) {
      for (const target of ALL_STATES) {
        const decision = decideCLTransition(makeCL({ state }), target, null);
        expect(decision).toMatchObject({ allow: false, role: "anonymous", reason: "unauthenticated" });
      }
    }
  });

  it("denies every transition for a non-author actor, regardless of state", () => {
    for (const state of ALL_STATES) {
      for (const target of ALL_STATES) {
        const decision = decideCLTransition(makeCL({ state }), target, "usr_stranger");
        expect(decision).toMatchObject({ allow: false, role: "stranger", reason: "forbidden" });
      }
    }
  });

  it("treats a same-state call from the author as an allowed no-op", () => {
    for (const state of ALL_STATES) {
      const decision = decideCLTransition(makeCL({ state }), state, "usr_author");
      expect(decision).toMatchObject({ allow: true, role: "author", noop: true });
    }
  });

  it("the full author × fromState × target matrix matches CL_STATE_TRANSITIONS", () => {
    for (const state of ALL_STATES) {
      for (const target of ALL_STATES) {
        if (state === target) continue;
        const legal = CL_STATE_TRANSITIONS[state].includes(target);
        // Pre-satisfy the queue-ready guard for legal ready→queued cases so
        // this loop isolates the *matrix* axis; the guard itself is tested
        // separately below.
        const cl = makeCL({ state, merge: target === "queued" ? "queue-ready" : "needs-review" });
        const decision = decideCLTransition(cl, target, "usr_author");
        if (legal) {
          expect(decision, `${state} -> ${target}`).toMatchObject({ allow: true, role: "author", noop: false });
        } else {
          expect(decision, `${state} -> ${target}`).toMatchObject({
            allow: false,
            role: "author",
            reason: "illegal-transition",
          });
        }
      }
    }
  });

  it("merged and closed are terminal — every outgoing target is illegal for the author", () => {
    for (const terminal of ["merged", "closed"] as const) {
      for (const target of ALL_STATES) {
        if (target === terminal) continue;
        const decision = decideCLTransition(makeCL({ state: terminal }), target, "usr_author");
        expect(decision).toMatchObject({ allow: false, reason: "illegal-transition" });
      }
    }
  });

  it("blocks ready -> queued while merge is not queue-ready (a reviewer has not approved)", () => {
    const cl = makeCL({ state: "ready", merge: "needs-review", reviewers: [reviewer("usr_r1", "pending")] });
    const decision = decideCLTransition(cl, "queued", "usr_author");
    expect(decision).toMatchObject({ allow: false, role: "author", reason: "queue-not-ready" });
  });

  it("allows ready -> queued once merge is queue-ready", () => {
    const cl = makeCL({ state: "ready", merge: "queue-ready", reviewers: [reviewer("usr_r1", "approved")] });
    const decision = decideCLTransition(cl, "queued", "usr_author");
    expect(decision).toMatchObject({ allow: true, role: "author", noop: false });
  });
});

describe("mergeStateForTransition", () => {
  it("derives in-queue / merged / rebase-needed unconditionally for their target states", () => {
    const cl = makeCL();
    expect(mergeStateForTransition("queued", cl)).toBe("in-queue");
    expect(mergeStateForTransition("merged", cl)).toBe("merged");
    expect(mergeStateForTransition("conflicts", cl)).toBe("rebase-needed");
  });

  it("derives queue-ready for 'ready' only when every reviewer has approved (vacuously true when empty)", () => {
    expect(mergeStateForTransition("ready", makeCL({ reviewers: [] }))).toBe("queue-ready");
    expect(mergeStateForTransition("ready", makeCL({ reviewers: [reviewer("usr_r1", "approved")] }))).toBe(
      "queue-ready",
    );
    expect(
      mergeStateForTransition(
        "ready",
        makeCL({ reviewers: [reviewer("usr_r1", "approved"), reviewer("usr_r2", "pending")] }),
      ),
    ).toBe("needs-review");
  });

  it("falls back to needs-review for wip/closed targets", () => {
    const cl = makeCL();
    expect(mergeStateForTransition("wip", cl)).toBe("needs-review");
    expect(mergeStateForTransition("closed", cl)).toBe("needs-review");
  });
});

describe("assertCLTransitionAllowed", () => {
  it("throws MegaUnauthorizedError for an unauthenticated decision", () => {
    const decision = decideCLTransition(makeCL(), "ready", null);
    expect(() => assertCLTransitionAllowed(decision, 1, "ready")).toThrow(MegaUnauthorizedError);
  });

  it("throws MegaForbiddenError for a non-author decision", () => {
    const decision = decideCLTransition(makeCL(), "ready", "usr_stranger");
    expect(() => assertCLTransitionAllowed(decision, 1, "ready")).toThrow(MegaForbiddenError);
  });

  it("throws MegaConflictError for an illegal transition and for a not-yet-queue-ready queue attempt", () => {
    const illegal = decideCLTransition(makeCL({ state: "merged" }), "wip", "usr_author");
    expect(() => assertCLTransitionAllowed(illegal, 1, "wip")).toThrow(MegaConflictError);

    const notReady = decideCLTransition(makeCL({ state: "ready", merge: "needs-review" }), "queued", "usr_author");
    expect(() => assertCLTransitionAllowed(notReady, 1, "queued")).toThrow(MegaConflictError);
  });

  it("does not throw for an allowed decision (including the same-state no-op)", () => {
    const decision = decideCLTransition(makeCL({ state: "wip" }), "ready", "usr_author");
    expect(() => assertCLTransitionAllowed(decision, 1, "ready")).not.toThrow();

    const noop = decideCLTransition(makeCL({ state: "wip" }), "wip", "usr_author");
    expect(() => assertCLTransitionAllowed(noop, 1, "wip")).not.toThrow();
  });
});
