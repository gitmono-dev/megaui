// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"

import { Switch } from "./switch"

afterEach(cleanup);

describe("Switch (UI-03 smoke)", () => {
  it("renders a radix switch role with the switch data-slot", () => {
    render(<Switch className="extra-class" />);
    const switchEl = screen.getByRole("switch");
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toHaveClass("extra-class");
    expect(switchEl).toHaveAttribute("data-slot", "switch");
  });
});

function ControlledSwitch() {
  const [checked, setChecked] = useState(false);
  return <Switch checked={checked} onCheckedChange={setChecked} />;
}

describe("Switch controlled value/onChange (UI-03 AC3)", () => {
  it("reflects the checked prop and calls onCheckedChange with the new state on click", async () => {
    const user = userEvent.setup();
    render(<ControlledSwitch />);
    const switchEl = screen.getByRole("switch");
    expect(switchEl).toHaveAttribute("aria-checked", "false");

    await user.click(switchEl);
    expect(switchEl).toHaveAttribute("aria-checked", "true");

    await user.click(switchEl);
    expect(switchEl).toHaveAttribute("aria-checked", "false");
  });

  it("calls a caller-supplied onCheckedChange handler with the new boolean", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
