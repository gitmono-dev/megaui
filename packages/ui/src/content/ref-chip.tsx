"use client";

import * as React from "react";
import type { DocRefNotation, RefNodeKind } from "@megaui/content";

export interface RefChipContract {
  readonly href?: string;
  readonly kind: RefNodeKind;
  readonly megaContent: "ref" | "ref-unresolved";
  readonly tagName: "a" | "span" | "button";
  readonly text: string;
}

function wikilinkTitle(contract: RefChipContract): string | null {
  if (contract.kind !== "doc" || !contract.text.startsWith("[[") || !contract.text.endsWith("]]")) return null;
  return contract.text.slice(2, -2);
}

/** Keeps literal page brackets in document text while limiting link styling to the page title. */
export function ReferenceChip({
  contract,
  nodeKey,
  refTitle,
  notation,
}: {
  readonly contract: RefChipContract;
  readonly nodeKey?: string;
  readonly refTitle?: string;
  readonly notation?: DocRefNotation;
}): React.JSX.Element {
  const title = wikilinkTitle(contract);
  const props: Record<string, unknown> = {
    "data-mega-content": contract.megaContent,
    "data-ref-kind": contract.kind,
    "data-ref-notation": notation,
  };
  if (nodeKey) props["data-node-key"] = nodeKey;
  if (refTitle) props["data-ref-title"] = refTitle;
  if (contract.tagName === "a" && contract.href) props.href = contract.href;
  if (contract.tagName === "button") props.type = "button";
  const trigger = React.createElement(contract.tagName, props, title ?? contract.text);

  if (title === null) return trigger;
  return (
    <>
      <span aria-hidden="true" data-mega-content="ref-bracket">[[</span>
      {trigger}
      <span aria-hidden="true" data-mega-content="ref-bracket">]]</span>
    </>
  );
}
