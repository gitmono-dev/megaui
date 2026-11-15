"use client";

import * as React from "react";
import { MegaOutlineTableNode, type SerializedMegaOutlineTableNode } from "@megaui/content";
import { OutlineTableView } from "./plugins/outline-table";

/** React renderer for the saved table projection node. */
export class EditorOutlineTableNode extends MegaOutlineTableNode {
  static getType(): string { return super.getType(); }
  static clone(node: EditorOutlineTableNode): EditorOutlineTableNode {
    return new EditorOutlineTableNode(node.getBlockId(), node.getSourceBlockId(), node.getKey());
  }
  static importJSON(serialized: SerializedMegaOutlineTableNode): EditorOutlineTableNode {
    return new EditorOutlineTableNode(serialized.blockId, serialized.sourceBlockId);
  }
  createDOM(): HTMLElement {
    const element = document.createElement("div");
    element.dataset.megaOutlineTable = "true";
    element.dataset.blockId = this.getBlockId();
    element.dataset.sourceBlockId = this.getSourceBlockId();
    return element;
  }
  updateDOM(): false { return false; }
  decorate(): React.JSX.Element {
    return <OutlineTableView nodeKey={this.getKey()} sourceBlockId={this.getSourceBlockId()} />;
  }
}
