// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"

import { Slider } from "./slider"

afterEach(cleanup);

describe("Slider (UI-03 smoke)", () => {
  it("renders a radix slider thumb and forwards className to the root", () => {
    render(<Slider className="extra-class" defaultValue={[30]} />);
    const thumb = screen.getByRole("slider");
    expect(thumb).toBeInTheDocument();
    expect(thumb.closest(".extra-class")).not.toBeNull();
  });
});

function ControlledSlider() {
  const [value, setValue] = useState([20]);
  return <Slider value={value} onValueChange={setValue} min={0} max={100} step={10} />;
}

describe("Slider controlled value/onChange (UI-03 AC3)", () => {
  it("reflects the value prop via aria-valuenow and calls onValueChange on keyboard interaction", async () => {
    const user = userEvent.setup();
    render(<ControlledSlider />);
    const thumb = screen.getByRole("slider");
    expect(thumb).toHaveAttribute("aria-valuenow", "20");

    thumb.focus();
    await user.keyboard("{ArrowRight}");
    expect(thumb).toHaveAttribute("aria-valuenow", "30");
  });

  it("calls a caller-supplied onValueChange handler with the new value array", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Slider value={[20]} onValueChange={onValueChange} min={0} max={100} step={10} />);
    const thumb = screen.getByRole("slider");
    thumb.focus();
    await user.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenCalledWith([30]);
  });
});
