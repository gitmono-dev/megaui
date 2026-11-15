import { describe, expect, it } from "vitest"

import { isLikelyBinaryContent } from "./binary"

describe("isLikelyBinaryContent", () => {
  it("flags content containing a NUL byte", () => {
    expect(isLikelyBinaryContent("PNG\u0000\u0000\u0000IHDR")).toBe(true)
  })

  it("does not flag ordinary source text", () => {
    expect(isLikelyBinaryContent("export function add(a: number, b: number) {\n  return a + b\n}\n")).toBe(false)
  })

  it("does not flag an empty string", () => {
    expect(isLikelyBinaryContent("")).toBe(false)
  })

  it("only sniffs a bounded prefix (a NUL far past it does not count)", () => {
    const longText = "a".repeat(9_000) + "\u0000"
    expect(isLikelyBinaryContent(longText)).toBe(false)
  })

  it("catches a NUL byte within the sniffed prefix", () => {
    const withEarlyNul = "a".repeat(100) + "\u0000" + "b".repeat(100)
    expect(isLikelyBinaryContent(withEarlyNul)).toBe(true)
  })
})
