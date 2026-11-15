import { describe, expect, it } from "vitest";
import { countUnread, isReadTransition, isUnread, mergeReadAt } from "./unread";

describe("unread.ts (EG-09 AC2: unread aggregation + read semantics)", () => {
  it("isUnread: true iff readAt is null", () => {
    expect(isUnread({ readAt: null })).toBe(true);
    expect(isUnread({ readAt: new Date("2026-01-01T00:00:00.000Z") })).toBe(false);
  });

  it("countUnread: aggregates unread rows only, including the empty-set edge case", () => {
    expect(countUnread([])).toBe(0);
    expect(
      countUnread([
        { readAt: null },
        { readAt: new Date("2026-01-01T00:00:00.000Z") },
        { readAt: null },
      ]),
    ).toBe(2);
    expect(countUnread([{ readAt: new Date() }, { readAt: new Date() }])).toBe(0);
  });

  it("mergeReadAt: monotonic — an existing read_at is never overwritten by a later mark-read call", () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-02T00:00:00.000Z");
    expect(mergeReadAt(first, later)).toBe(first);
    expect(mergeReadAt(null, later)).toBe(later);
  });

  it("isReadTransition: only a currently-unread row transitions on mark-read (idempotent no-op otherwise)", () => {
    expect(isReadTransition(null)).toBe(true);
    expect(isReadTransition(new Date())).toBe(false);
  });
});
