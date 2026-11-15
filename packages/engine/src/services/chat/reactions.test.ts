import { describe, expect, it } from "vitest";
import { MegaBadRequestError } from "../../errors";
import { MAX_CHAT_MESSAGE_REACTIONS } from "./limits";
import { parseReactionRows, projectReactions, toggleReactionRow } from "./reactions";

describe("parseReactionRows (EG-07, pure)", () => {
  it("returns an empty array for non-array input", () => {
    expect(parseReactionRows(null)).toEqual([]);
    expect(parseReactionRows(undefined)).toEqual([]);
    expect(parseReactionRows("nope")).toEqual([]);
  });

  it("drops malformed entries and keeps well-formed ones", () => {
    const rows = parseReactionRows([
      { emoji: "👍", userIds: ["u1", "u2"] },
      { emoji: "", userIds: ["u1"] },
      { userIds: ["u1"] },
      null,
      { emoji: "🎉", userIds: "not-an-array" },
    ]);
    expect(rows).toEqual([
      { emoji: "👍", userIds: ["u1", "u2"] },
      { emoji: "🎉", userIds: [] },
    ]);
  });
});

describe("projectReactions (EG-07, per-actor projection, pure)", () => {
  const rows = [
    { emoji: "👍", userIds: ["u1", "u2"] },
    { emoji: "🎉", userIds: ["u2"] },
    { emoji: "😀", userIds: [] },
  ];

  it("computes count from the reactor set and reactedByMe for the viewing actor", () => {
    expect(projectReactions(rows, "u1")).toEqual([
      { emoji: "👍", count: 2, reactedByMe: true },
      { emoji: "🎉", count: 1, reactedByMe: false },
    ]);
  });

  it("returns reactedByMe=false for every entry when there is no actor", () => {
    expect(projectReactions(rows, null)).toEqual([
      { emoji: "👍", count: 2, reactedByMe: false },
      { emoji: "🎉", count: 1, reactedByMe: false },
    ]);
  });

  it("drops emoji entries with an empty reactor set", () => {
    expect(projectReactions(rows, "u2").some((reaction) => reaction.emoji === "😀")).toBe(false);
  });
});

describe("toggleReactionRow (EG-07, actor-aware toggle, pure)", () => {
  it("adds a new distinct emoji reacted by the actor", () => {
    const next = toggleReactionRow([], "👍", "u1");
    expect(next).toEqual([{ emoji: "👍", userIds: ["u1"] }]);
  });

  it("adds the actor to an existing emoji's reactor set without duplicating", () => {
    const rows = [{ emoji: "👍", userIds: ["u1"] }];
    const next = toggleReactionRow(rows, "👍", "u2");
    expect(next).toEqual([{ emoji: "👍", userIds: ["u1", "u2"] }]);
  });

  it("removes the actor's own reaction on a second toggle and prunes the emoji when empty", () => {
    const rows = [{ emoji: "👍", userIds: ["u1"] }];
    const next = toggleReactionRow(rows, "👍", "u1");
    expect(next).toEqual([]);
  });

  it("does not mutate the input array (pure)", () => {
    const rows = [{ emoji: "👍", userIds: ["u1"] }];
    toggleReactionRow(rows, "👍", "u2");
    expect(rows).toEqual([{ emoji: "👍", userIds: ["u1"] }]);
  });

  it("trims the emoji and rejects a blank one", () => {
    expect(toggleReactionRow([], "  🎉  ", "u1")).toEqual([{ emoji: "🎉", userIds: ["u1"] }]);
    expect(() => toggleReactionRow([], "   ", "u1")).toThrow(MegaBadRequestError);
  });

  it("rejects a brand-new distinct emoji once the GC-10 cap is reached, but still allows toggling an existing one off", () => {
    const atCap = Array.from({ length: MAX_CHAT_MESSAGE_REACTIONS }, (_, index) => ({
      emoji: `emoji-${index}`,
      userIds: ["u1"],
    }));
    expect(() => toggleReactionRow(atCap, "one-too-many", "u2")).toThrow(MegaBadRequestError);
    expect(toggleReactionRow(atCap, "emoji-0", "u1")).toHaveLength(MAX_CHAT_MESSAGE_REACTIONS - 1);
  });
});
