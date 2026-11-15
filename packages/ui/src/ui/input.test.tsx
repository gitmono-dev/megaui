// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { Input } from "./input"

afterEach(cleanup);

describe("Input (UI-03 smoke)", () => {
  it("renders a native <input> and forwards props/className", () => {
    render(<Input placeholder="Search" className="extra-class" data-testid="in" />)
    const input = screen.getByPlaceholderText("Search");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveClass("extra-class");
    expect(input).toHaveAttribute("data-slot", "input");
  });

  it("forwards the type prop", () => {
    render(<Input type="email" data-testid="in" />);
    expect(screen.getByTestId("in")).toHaveAttribute("type", "email");
  });
});

function ControlledInput() {
  const [value, setValue] = useState("");
  return (
    <Input
      data-testid="controlled-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

describe("Input controlled value/onChange (UI-03 AC3)", () => {
  it("reflects the value prop and calls onChange with the new value on user input", () => {
    render(<ControlledInput />);
    const input = screen.getByTestId("controlled-input") as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "hello" } });
    expect(input.value).toBe("hello");
  });

  it("calls a caller-supplied onChange handler with the raw change event", () => {
    const onChange = vi.fn();
    render(<Input value="fixed" onChange={onChange} data-testid="in" />);
    fireEvent.change(screen.getByTestId("in"), { target: { value: "next" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
