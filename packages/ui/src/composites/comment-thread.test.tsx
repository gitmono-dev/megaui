// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { CommentThread, type CommentAuthor } from "./comment-thread"

expect.extend(matchers)
afterEach(() => cleanup())

const AUTHOR: CommentAuthor = { id: "u1", displayName: "Tianjing", avatarInitials: "TJ" }

describe("CommentThread (UI-09, upstream:libs/react-shared/components/mega/composites/comment-card.tsx)", () => {
  it("renders the author, body and timestamp (smoke)", () => {
    render(<CommentThread author={AUTHOR} body="Looks good to me." id="c1" timestampLabel="2h ago" />)
    expect(screen.getByText("Tianjing")).toBeInTheDocument()
    expect(screen.getByText("Looks good to me.")).toBeInTheDocument()
    expect(screen.getByText("2h ago")).toBeInTheDocument()
  })

  it("renders replies under the thread", () => {
    render(
      <CommentThread
        author={AUTHOR}
        body="Looks good to me."
        id="c1"
        replies={[
          { author: { id: "u2", displayName: "Ada", avatarInitials: "AL" }, body: "Agreed.", id: "r1", timestampLabel: "1h ago" },
        ]}
        timestampLabel="2h ago"
      />
    )
    expect(screen.getByText("Ada")).toBeInTheDocument()
    expect(screen.getByText("Agreed.")).toBeInTheDocument()
  })

  it("renders the assistant tone with an accent avatar surface", () => {
    render(<CommentThread author={AUTHOR} body="Here is a summary." id="c1" timestampLabel="now" tone="assistant" />)
    expect(document.querySelector('[data-slot="comment-thread"]')).toHaveClass("flex")
    expect(screen.getByRole("img", { name: "Tianjing" })).toBeInTheDocument()
  })

  it("fires onReactionToggle when a reaction pill is clicked (interaction)", async () => {
    const user = userEvent.setup()
    const onReactionToggle = vi.fn()
    render(
      <CommentThread
        author={AUTHOR}
        body="Ship it."
        id="c1"
        reactions={{ onReactionToggle, reactions: [{ count: 2, emoji: "🚀", reactedByMe: false }] }}
        timestampLabel="now"
      />
    )
    await user.click(screen.getByRole("button", { name: "🚀 2" }))
    expect(onReactionToggle).toHaveBeenCalledTimes(1)
  })

  it("renders a skeleton placeholder instead of content when loading (loading state)", () => {
    render(<CommentThread author={AUTHOR} body="Hidden while loading." id="c1" loading timestampLabel="now" />)
    expect(screen.queryByText("Hidden while loading.")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="comment-thread-skeleton"]')).toBeInTheDocument()
  })
})
