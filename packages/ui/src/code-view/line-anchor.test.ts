import { describe, expect, it } from "vitest"

import { formatLineAnchor, parseLineAnchor } from "./line-anchor"

describe("parseLineAnchor", () => {
  it("parses a single-line anchor", () => {
    expect(parseLineAnchor("#L42")).toEqual({ end: 42, start: 42 })
  })

  it("parses a range anchor", () => {
    expect(parseLineAnchor("#L10-L20")).toEqual({ end: 20, start: 10 })
  })

  it("tolerates a leading hash omitted", () => {
    expect(parseLineAnchor("L5")).toEqual({ end: 5, start: 5 })
  })

  it("rejects a malformed fragment", () => {
    expect(parseLineAnchor("#foo")).toBeUndefined()
    expect(parseLineAnchor("")).toBeUndefined()
    expect(parseLineAnchor("#L")).toBeUndefined()
  })

  it("rejects a zero or negative start", () => {
    expect(parseLineAnchor("#L0")).toBeUndefined()
  })

  it("rejects an inverted range", () => {
    expect(parseLineAnchor("#L20-L10")).toBeUndefined()
  })
})

describe("formatLineAnchor", () => {
  it("formats a single-line range without a dash", () => {
    expect(formatLineAnchor({ end: 42, start: 42 })).toBe("#L42")
  })

  it("formats a multi-line range", () => {
    expect(formatLineAnchor({ end: 20, start: 10 })).toBe("#L10-L20")
  })

  it("round-trips through parseLineAnchor", () => {
    const range = { end: 88, start: 12 }
    expect(parseLineAnchor(formatLineAnchor(range))).toEqual(range)
  })
})
