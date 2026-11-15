// @vitest-environment happy-dom
import * as React from "react";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocReferenceBadges } from "./block-reference-badges";

afterEach(cleanup);

describe("DocReferenceBadges", () => {
  it("shows the readable count on its source block and opens its sources", async () => {
    const articleRef = createRef<HTMLDivElement>();
    const onOpen = vi.fn();
    render(
      <div ref={articleRef}>
        <div data-block-id="cited" data-mega-block="text">Target</div>
        <div data-block-id="uncited" data-mega-block="text">Other</div>
        <DocReferenceBadges articleRef={articleRef} counts={{ cited: 2 }} label="{count} references" onOpen={onOpen} />
      </div>,
    );
    const badge = await screen.findByRole("button", { name: "2 references" });
    expect(badge).toHaveAttribute("data-block-id", "cited");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledWith("cited");
    await waitFor(() => expect(screen.getByRole("button", { name: "2 references" })).toBeInTheDocument());
  });

  it("hides a cited child while its parent is collapsed", async () => {
    const articleRef = createRef<HTMLDivElement>();
    render(
      <div ref={articleRef}>
        <div data-block-id="parent" data-mega-block="text">
          <div data-block-id="child" data-mega-block="text">Child</div>
        </div>
        <DocReferenceBadges articleRef={articleRef} counts={{ child: 1 }} label="{count} references" onOpen={vi.fn()} />
      </div>,
    );
    expect(await screen.findByRole("button", { name: "1 references" })).toBeInTheDocument();
    screen.getByText("Child").parentElement?.setAttribute("data-collapsed", "true");
    await waitFor(() => expect(screen.queryByRole("button", { name: "1 references" })).not.toBeInTheDocument());
  });
});
