// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import { Message, MessageAvatar, MessageCitations, MessageContent, MessageUsage } from "./message"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Message (UI-09, upstream:libs/react-shared/components/ai-elements/message.tsx)", () => {
  it("marks the message role via a data attribute (smoke)", () => {
    render(
      <Message data-testid="msg" from="assistant">
        <MessageContent>Hello there</MessageContent>
      </Message>
    )
    expect(screen.getByTestId("msg")).toHaveAttribute("data-message-role", "assistant")
    expect(screen.getByText("Hello there")).toBeInTheDocument()
  })

  it("renders the avatar fallback from the caller-supplied name (no hardcoded fallback text)", () => {
    render(<MessageAvatar data-testid="avatar" name="Agent Smith" />)
    expect(screen.getByText("Ag")).toBeInTheDocument()
  })
})

describe("MessageCitations (UI-09, megaui-only)", () => {
  it("renders each citation as a link (smoke)", () => {
    render(
      <MessageCitations
        citations={[{ detail: "L1-20", id: "cit_1", kind: "file", label: "src/index.ts", url: "/code/src/index.ts" }]}
        label="Sources"
      />
    )
    expect(screen.getByText("Sources")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "src/index.ts" })).toHaveAttribute("href", "/code/src/index.ts")
  })

  it("renders nothing when there are no citations (empty state)", () => {
    const { container } = render(<MessageCitations citations={[]} label="Sources" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("MessageUsage (UI-09, megaui-only)", () => {
  it("renders each already-formatted usage stat (smoke)", () => {
    render(<MessageUsage items={[{ label: "Tokens", value: "128" }]} />)
    expect(screen.getByText("Tokens")).toBeInTheDocument()
    expect(screen.getByText("128")).toBeInTheDocument()
  })

  it("renders nothing when there are no usage items (empty state)", () => {
    const { container } = render(<MessageUsage items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
