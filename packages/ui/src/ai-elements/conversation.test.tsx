// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./conversation"

expect.extend(matchers)
afterEach(() => cleanup())

function Harness() {
  return (
    <Conversation data-testid="conversation">
      <ConversationContent>
        <div>Message 1</div>
      </ConversationContent>
      <ConversationScrollButton label="Scroll to latest" />
    </Conversation>
  )
}

describe("Conversation (UI-09, upstream:libs/react-shared/components/ai-elements/conversation.tsx)", () => {
  it("renders its content as a log region (smoke)", () => {
    render(<Harness />)
    expect(screen.getByRole("log")).toBeInTheDocument()
    expect(screen.getByText("Message 1")).toBeInTheDocument()
  })

  it("hides the scroll-to-bottom button while already at the bottom", () => {
    render(<Harness />)
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull()
  })

  it("shows the scroll-to-bottom button once scrolled away, and clicking it scrolls back down (interaction)", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const container = screen.getByTestId("conversation")
    const scrollTo = vi.fn()
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 })
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 0 })
    container.scrollTo = scrollTo

    fireEvent.scroll(container)
    const button = await screen.findByRole("button", { name: "Scroll to latest" })

    await user.click(button)
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 1000 })
  })

  it("composes caller onScroll without letting props overwrite the internal handler", () => {
    const onScroll = vi.fn()
    render(
      <Conversation data-testid="conversation" onScroll={onScroll}>
        <ConversationContent>hi</ConversationContent>
        <ConversationScrollButton label="Scroll to latest" />
      </Conversation>,
    )
    const container = screen.getByTestId("conversation")
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 })
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 0 })
    fireEvent.scroll(container)
    expect(onScroll).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Scroll to latest" })).toBeInTheDocument()
  })

  it("composes caller onClick on the scroll button without dropping scrollToBottom", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Conversation data-testid="conversation">
        <ConversationContent>hi</ConversationContent>
        <ConversationScrollButton label="Scroll to latest" onClick={onClick} />
      </Conversation>,
    )
    const container = screen.getByTestId("conversation")
    const scrollTo = vi.fn()
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 })
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 0 })
    container.scrollTo = scrollTo
    fireEvent.scroll(container)
    await user.click(await screen.findByRole("button", { name: "Scroll to latest" }))
    expect(scrollTo).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("recomputes bottom state when content grows without a scroll event", async () => {
    function Growing({ tall }: { tall: boolean }) {
      return (
        <Conversation data-testid="conversation">
          <ConversationContent>
            <div style={{ height: tall ? 1000 : 10 }}>body</div>
          </ConversationContent>
          <ConversationScrollButton label="Scroll to latest" />
        </Conversation>
      )
    }
    const { rerender } = render(<Growing tall={false} />)
    const container = screen.getByTestId("conversation")
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 40 })
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 })
    Object.defineProperty(container, "scrollTop", { configurable: true, value: 0 })
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull()

    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 })
    rerender(<Growing tall={true} />)
    expect(await screen.findByRole("button", { name: "Scroll to latest" })).toBeInTheDocument()
  })

  it("renders an empty state when there is no conversation yet (empty state)", () => {
    render(
      <Conversation>
        <ConversationEmptyState title="No messages yet" />
      </Conversation>
    )
    expect(screen.getByText("No messages yet")).toBeInTheDocument()
  })

  it("renders an error-toned empty state when the conversation fails to load (error state)", () => {
    render(
      <Conversation>
        <ConversationEmptyState title="Failed to load conversation" tone="error" />
      </Conversation>
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load conversation")
  })
})
