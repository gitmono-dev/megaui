// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"

afterEach(cleanup);

function DemoDialog() {
  return (
    <Dialog>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog (UI-03 smoke)", () => {
  it("does not render its content until opened", () => {
    render(<DemoDialog />);
    expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("opens on trigger click and shows title/description, then closes on close click", async () => {
    const user = userEvent.setup();
    render(<DemoDialog />);

    await user.click(screen.getByText("Open"));
    expect(await screen.findByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-slot", "dialog-content");

    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
  });
});
