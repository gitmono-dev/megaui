// @vitest-environment happy-dom
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceChip } from "./ref-chip";

afterEach(cleanup);

describe("ReferenceChip", () => {
  it("keeps wikilink brackets neutral while making only the title an anchor", () => {
    const { container } = render(
      <ReferenceChip
        contract={{ href: "/workspace/docs/doc-1", kind: "doc", megaContent: "ref", tagName: "a", text: "[[Roadmap]]" }}
      />,
    );

    const link = screen.getByRole("link", { name: "Roadmap" });
    expect(link).toHaveAttribute("href", "/workspace/docs/doc-1");
    expect(link).toHaveTextContent("Roadmap");
    expect(container.querySelectorAll('[data-mega-content="ref-bracket"]')).toHaveLength(2);
    expect(container).toHaveTextContent("[[Roadmap]]");
  });
});
