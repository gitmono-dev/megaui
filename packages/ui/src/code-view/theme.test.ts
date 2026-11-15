// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { MEGA_CODE_THEMES } from "./themes-shared"
import { useMegaCodeThemeType } from "./theme"

afterEach(() => {
  document.documentElement.classList.remove("dark")
})

describe("MEGA_CODE_THEMES", () => {
  it("names the dual Shiki themes", () => {
    expect(MEGA_CODE_THEMES).toEqual({ dark: "github-dark", light: "github-light" })
  })
})

describe("useMegaCodeThemeType", () => {
  it("reads light by default", () => {
    const { result } = renderHook(() => useMegaCodeThemeType())
    expect(result.current).toBe("light")
  })

  it("reads dark when the document root already has the dark class", () => {
    document.documentElement.classList.add("dark")
    const { result } = renderHook(() => useMegaCodeThemeType())
    expect(result.current).toBe("dark")
  })

  it("reacts to the root class changing after mount", async () => {
    const { result } = renderHook(() => useMegaCodeThemeType())
    expect(result.current).toBe("light")

    act(() => {
      document.documentElement.classList.add("dark")
    })
    await waitFor(() => expect(result.current).toBe("dark"))
  })
})
