// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import { ChatMessage, ChatMessageQuote, ChatSystemMessage, type ChatMessageAuthor } from "./chat-message"

expect.extend(matchers)
afterEach(() => cleanup())

const AUTHOR: ChatMessageAuthor = { id: "u1", displayName: "Tianjing", avatarInitials: "TJ" }

describe("ChatMessage (UI-09, upstream:libs/react-shared/components/mega/composites/message-row.tsx)", () => {
  it("renders the author, body and timestamp when ungrouped (smoke)", () => {
    render(<ChatMessage author={AUTHOR} body="Deploying now." id="m1" timestampLabel="10:02" />)
    expect(screen.getByText("Tianjing")).toBeInTheDocument()
    expect(screen.getByText("Deploying now.")).toBeInTheDocument()
    expect(screen.getByText("10:02")).toBeInTheDocument()
  })

  it("hides the header/avatar for grouped consecutive messages", () => {
    render(<ChatMessage author={AUTHOR} body="Follow-up line." grouped id="m2" timestampLabel="10:03" />)
    expect(screen.queryByText("Tianjing")).not.toBeInTheDocument()
    expect(screen.getByText("Follow-up line.")).toBeInTheDocument()
  })

  it("shows the edited label and fires onEdit when the edit trigger is clicked (interaction)", async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(
      <ChatMessage
        author={AUTHOR}
        body="Typo fixed."
        editedLabel="(edited)"
        editLabel="Edit"
        id="m3"
        onEdit={onEdit}
        timestampLabel="10:04"
      />
    )
    expect(screen.getByText("(edited)")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Edit" }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("renders a ChatSystemMessage as a status line", () => {
    render(<ChatSystemMessage>Ada joined the channel.</ChatSystemMessage>)
    expect(screen.getByRole("status")).toHaveTextContent("Ada joined the channel.")
  })

  it("renders a ChatMessageQuote and fires onClear when dismissed (interaction)", async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(<ChatMessageQuote author={{ displayName: "Ada" }} body="Original message" clearLabel="Clear quote" onClear={onClear} />)
    expect(screen.getByText("Ada")).toBeInTheDocument()
    expect(screen.getByText("Original message")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear quote" }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
