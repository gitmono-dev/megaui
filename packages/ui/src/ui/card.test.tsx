// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card"

expect.extend(matchers)
afterEach(() => cleanup())

describe("Card composition (UI-02, upstream:libs/react-shared/ui/card.tsx)", () => {
  it("renders the full composition with each part's data-slot and text (smoke)", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title text</CardTitle>
          <CardDescription>Description text</CardDescription>
          <CardAction>
            <button type="button">Action</button>
          </CardAction>
        </CardHeader>
        <CardContent>Content text</CardContent>
        <CardFooter>Footer text</CardFooter>
      </Card>
    )

    expect(screen.getByText("Title text")).toBeInTheDocument()
    expect(screen.getByText("Description text")).toBeInTheDocument()
    expect(screen.getByText("Content text")).toBeInTheDocument()
    expect(screen.getByText("Footer text")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument()

    expect(screen.getByText("Title text")).toHaveAttribute("data-slot", "card-title")
    expect(screen.getByText("Description text")).toHaveAttribute(
      "data-slot",
      "card-description"
    )
    expect(screen.getByText("Content text")).toHaveAttribute("data-slot", "card-content")
    expect(screen.getByText("Footer text")).toHaveAttribute("data-slot", "card-footer")
  })

  it("Card root carries data-slot=card and the base container classes", () => {
    render(<Card data-testid="root">Body</Card>)
    const root = screen.getByTestId("root")
    expect(root).toHaveAttribute("data-slot", "card")
    expect(root.className).toContain("rounded-xl")
    expect(root.className).toContain("border")
  })

  it("merges a caller-provided className on every sub-part", () => {
    render(<CardContent className="custom-content">x</CardContent>)
    expect(screen.getByText("x")).toHaveAttribute("data-slot", "card-content")
    expect(screen.getByText("x").className).toContain("custom-content")
  })
})
