// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as matchers from "@testing-library/jest-dom/matchers"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog"

expect.extend(matchers)
afterEach(() => cleanup())

function ExampleAlertDialog({ onAction }: { onAction?: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
          <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onAction}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

describe("AlertDialog (UI-02, upstream:libs/react-shared/ui/alert-dialog.tsx)", () => {
  it("is closed until the trigger is activated, then renders role=alertdialog with title/description (smoke)", async () => {
    const user = userEvent.setup()
    render(<ExampleAlertDialog />)

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText("Are you absolutely sure?")).toBeInTheDocument()
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument()
  })

  it("a11y: dialog title/description are wired via aria-labelledby/aria-describedby", async () => {
    const user = userEvent.setup()
    render(<ExampleAlertDialog />)
    await user.click(screen.getByRole("button", { name: "Delete" }))

    const dialog = await screen.findByRole("alertdialog")
    const title = screen.getByText("Are you absolutely sure?")
    const description = screen.getByText("This action cannot be undone.")

    expect(dialog).toHaveAttribute("aria-labelledby", title.id)
    expect(dialog).toHaveAttribute("aria-describedby", description.id)
  })

  it("a11y: focus moves into the dialog content on open", async () => {
    const user = userEvent.setup()
    render(<ExampleAlertDialog />)
    await user.click(screen.getByRole("button", { name: "Delete" }))

    const dialog = await screen.findByRole("alertdialog")
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
  })

  it("Cancel closes the dialog and Action fires its onClick before closing", async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    render(<ExampleAlertDialog onAction={onAction} />)

    await user.click(screen.getByRole("button", { name: "Delete" }))
    await screen.findByRole("alertdialog")

    await user.click(screen.getByRole("button", { name: "Continue" }))
    expect(onAction).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("keeps the upstream variant API: Cancel uses the outline button variant, Action uses the default", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Continue</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    )
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("border-input")
    expect(screen.getByRole("button", { name: "Continue" }).className).toContain("bg-primary")
  })
})
