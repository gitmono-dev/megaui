"use client";

import * as React from "react";
import { MegaImageNode, type SerializedMegaImageNode } from "@megaui/content";

export class ReaderImageNode extends MegaImageNode {
  static getType(): string { return super.getType() }
  static clone(node: ReaderImageNode): ReaderImageNode { return new ReaderImageNode(node.getImage(), node.getKey()) }
  static importJSON(serialized: SerializedMegaImageNode): ReaderImageNode { return new ReaderImageNode(serialized.image) }
  createDOM(): HTMLElement { return document.createElement("span") }
  updateDOM(): false { return false }
  decorate(): React.JSX.Element {
    const { src, alt } = this.getImage();
    return (
      <span data-mega-content="image">
        <img alt={alt} loading="lazy" src={src} style={{ height: "auto", maxWidth: "100%" }} />
      </span>
    );
  }
}
