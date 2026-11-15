import { describe, expect, it } from "vitest"

import { selectRailChannels, selectRailDirectMessages, type RailChannel } from "./rail-channels"

const channels: readonly RailChannel[] = [
  { id: "general", kind: "channel", mentionCount: 0, name: "general", unreadCount: 0 },
  { id: "dm-1", kind: "dm", mentionCount: 0, name: "Eleanor Vance", participant: { displayName: "Eleanor Vance", username: "eleanor" }, unreadCount: 2 },
  { id: "code-review", kind: "channel", mentionCount: 1, name: "code-review", unreadCount: 3 },
  { id: "dm-2", kind: "dm", mentionCount: 0, name: "Naozumi Fujiwara", participant: { displayName: "Naozumi Fujiwara", status: "away", username: "naozumi" }, unreadCount: 0 },
]

describe("rail-channels (UI-05 AC1: rail entity selection)", () => {
  it("selects only kind=channel entries, preserving caller order", () => {
    expect(selectRailChannels(channels).map((channel) => channel.id)).toEqual(["general", "code-review"])
  })

  it("selects only kind=dm entries, preserving caller order", () => {
    expect(selectRailDirectMessages(channels).map((channel) => channel.participant.username)).toEqual(["eleanor", "naozumi"])
  })

  it("returns empty arrays for an empty input", () => {
    expect(selectRailChannels([])).toEqual([])
    expect(selectRailDirectMessages([])).toEqual([])
  })
})
