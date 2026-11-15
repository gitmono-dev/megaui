// @vitest-environment happy-dom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

afterEach(cleanup);

function DemoSelect(props: {
  value?: string;
  onValueChange?: (value: string) => void;
  defaultValue?: string;
}) {
  return (
    <Select {...props}>
      <SelectTrigger className="extra-class" data-testid="trigger">
        <SelectValue placeholder="Pick a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">Apple</SelectItem>
        <SelectItem value="banana">Banana</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("Select (UI-03 smoke)", () => {
  it("renders a trigger showing the placeholder when no value is set", () => {
    render(<DemoSelect />);
    const trigger = screen.getByTestId("trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass("extra-class");
    expect(trigger).toHaveAttribute("data-slot", "select-trigger");
    expect(screen.getByText("Pick a fruit")).toBeInTheDocument();
  });

  it("opens the listbox on trigger click and shows the options", async () => {
    const user = userEvent.setup();
    render(<DemoSelect />);
    await user.click(screen.getByTestId("trigger"));
    expect(await screen.findByText("Banana")).toBeInTheDocument();
    expect(screen.getByText("Apple")).toBeInTheDocument();
  });
});

function ControlledSelect() {
  const [value, setValue] = useState("apple");
  return <DemoSelect value={value} onValueChange={setValue} />;
}

describe("Select controlled value/onChange (UI-03 AC3)", () => {
  it("reflects the value prop as the displayed selected label", () => {
    render(<ControlledSelect />);
    expect(screen.getByText("Apple")).toBeInTheDocument();
  });

  it("calls a caller-supplied onValueChange handler with the picked option's value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<DemoSelect value="apple" onValueChange={onValueChange} />);

    await user.click(screen.getByTestId("trigger"));
    await user.click(await screen.findByText("Banana"));

    expect(onValueChange).toHaveBeenCalledWith("banana");
  });
});
