// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

import { Progress } from "./progress"

afterEach(cleanup);

describe("Progress (UI-03 smoke)", () => {
  it("renders a progressbar with the progress data-slot and forwards className", () => {
    render(<Progress value={40} className="extra-class" />);
    const progress = screen.getByRole("progressbar");
    expect(progress).toBeInTheDocument();
    expect(progress).toHaveClass("extra-class");
    expect(progress).toHaveAttribute("data-slot", "progress");
  });

  it("translates the indicator based on the value prop", () => {
    render(<Progress value={40} />);
    const indicator = screen.getByRole("progressbar").querySelector('[data-slot="progress-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator).toHaveStyle({ transform: "translateX(-60%)" });
  });

  it("treats a missing value as 0 (fully translated out)", () => {
    render(<Progress />);
    const indicator = screen.getByRole("progressbar").querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ transform: "translateX(-100%)" });
  });
});
