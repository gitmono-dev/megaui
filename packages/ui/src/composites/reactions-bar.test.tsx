// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { ReactionsBar, type ReactionItem } from "./reactions-bar"

expect.extend(matchers)
afterEach(() => cleanup())

const REACTIONS: readonly ReactionItem[] = [
  { emoji: "👍", count: 3, reactedByMe: true },
  { emoji: "🎉", count: 1, reactedByMe: false },
]

describe("ReactionsBar (UI-09, upstream:libs/react-shared/components/mega/composites/comment-card.tsx)", () => {
  it("renders reaction pills with their emoji + count (smoke)", () => {
    render(<ReactionsBar reactions={REACTIONS} />)
    expect(screen.getByText("👍 3")).toBeInTheDocument()
    expect(screen.getByText("🎉 1")).toBeInTheDocument()
  })

  it("renders read-only spans (not buttons) when no onReactionToggle is supplied", () => {
    render(<ReactionsBar reactions={REACTIONS} />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("👍 3").tagName).toBe("SPAN")
  })

  it("renders interactive pressed buttons and fires onReactionToggle on click", async () => {
    const user = userEvent.setup()
    const onReactionToggle = vi.fn()
    render(<ReactionsBar onReactionToggle={onReactionToggle} reactions={REACTIONS} />)

    const liked = screen.getByRole("button", { name: "👍 3" })
    expect(liked).toHaveAttribute("aria-pressed", "true")

    await user.click(liked)
    expect(onReactionToggle).toHaveBeenCalledWith(REACTIONS[0])
  })

  it("renders nothing (empty state) when there are no reactions and no add action", () => {
    const { container } = render(<ReactionsBar reactions={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("still renders the add-reaction trigger when reactions are empty but addAction is supplied", () => {
    render(<ReactionsBar addAction={{ emojiOptions: ["👍"], label: "Add reaction", onAdd: vi.fn() }} reactions={[]} />)
    expect(screen.getByRole("button", { name: "Add reaction" })).toBeInTheDocument()
  })

  it("opens an emoji picker from the add-reaction trigger and calls onAdd with the picked emoji", async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(
      <ReactionsBar
        addAction={{ emojiOptions: ["🚀", "❤️"], label: "Add reaction", onAdd }}
        reactions={REACTIONS}
      />
    )

    await user.click(screen.getByRole("button", { name: "Add reaction" }))
    const rocket = await screen.findByText("🚀")
    await user.click(rocket)

    expect(onAdd).toHaveBeenCalledWith("🚀")
  })
})
