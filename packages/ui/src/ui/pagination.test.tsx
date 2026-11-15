// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as matchers from "@testing-library/jest-dom/matchers"

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./pagination"

expect.extend(matchers)
afterEach(() => cleanup())

function DemoPagination() {
  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#prev" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#1">1</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#2" isActive>
            2
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#next" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

describe("Pagination (UI-11, upstream:libs/react-shared/ui/pagination.tsx)", () => {
  it("renders a navigation landmark labeled 'pagination' (smoke + a11y)", () => {
    render(<DemoPagination />)
    const nav = screen.getByRole("navigation", { name: "pagination" })
    expect(nav).toBeInTheDocument()
    expect(nav).toHaveAttribute("data-slot", "pagination")
  })

  it("marks the active page link with aria-current and data-active", () => {
    render(<DemoPagination />)
    const active = screen.getByRole("link", { name: "2" })
    expect(active).toHaveAttribute("aria-current", "page")
    expect(active).toHaveAttribute("data-active", "true")
    expect(active.className).toContain("border-input")

    const inactive = screen.getByRole("link", { name: "1" })
    expect(inactive).not.toHaveAttribute("aria-current")
    expect(inactive).not.toHaveAttribute("data-active")
  })

  it("Previous/Next expose accessible labels with a default visible label", () => {
    render(<DemoPagination />)
    expect(screen.getByRole("link", { name: "Go to previous page" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Go to next page" })).toBeInTheDocument()
    expect(screen.getByText("Previous")).toBeInTheDocument()
    expect(screen.getByText("Next")).toBeInTheDocument()
  })

  it("supports a caller-overridable visible label on Previous/Next", () => {
    render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="#prev" label="上一页" />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="#next" label="下一页" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    )
    expect(screen.getByText("上一页")).toBeInTheDocument()
    expect(screen.getByText("下一页")).toBeInTheDocument()
  })

  it("renders an aria-hidden ellipsis with a screen-reader-only label", () => {
    render(<DemoPagination />)
    expect(screen.getByText("More pages")).toHaveClass("sr-only")
  })
})
