// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { Textarea } from "./textarea"

afterEach(cleanup);

describe("Textarea (UI-03 smoke)", () => {
  it("renders a native <textarea> and forwards props/className", () => {
    render(<Textarea placeholder="Notes" className="extra-class" data-testid="ta" />);
    const textarea = screen.getByPlaceholderText("Notes");
    expect(textarea).toBeInTheDocument();
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveClass("extra-class");
    expect(textarea).toHaveAttribute("data-slot", "textarea");
  });
});

function ControlledTextarea() {
  const [value, setValue] = useState("");
  return (
    <Textarea
      data-testid="controlled-textarea"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

describe("Textarea controlled value/onChange (UI-03 AC3)", () => {
  it("reflects the value prop and calls onChange with the new value on user input", () => {
    render(<ControlledTextarea />);
    const textarea = screen.getByTestId("controlled-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    fireEvent.change(textarea, { target: { value: "multi\nline" } });
    expect(textarea.value).toBe("multi\nline");
  });

  it("calls a caller-supplied onChange handler with the raw change event", () => {
    const onChange = vi.fn();
    render(<Textarea value="fixed" onChange={onChange} data-testid="ta" />);
    fireEvent.change(screen.getByTestId("ta"), { target: { value: "next" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
