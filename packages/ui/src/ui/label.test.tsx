// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { Label } from "./label"
import { Input } from "./input"

afterEach(cleanup);

describe("Label (UI-03 smoke)", () => {
  it("renders its children and forwards className", () => {
    render(<Label className="extra-class">Email</Label>);
    const label = screen.getByText("Email");
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass("extra-class");
    expect(label).toHaveAttribute("data-slot", "label");
  });

  it("associates with a form control via htmlFor", () => {
    render(
      <>
        <Label htmlFor="email-input">Email</Label>
        <Input id="email-input" />
      </>
    );
    const label = screen.getByText("Email");
    expect(label).toHaveAttribute("for", "email-input");
  });
});
