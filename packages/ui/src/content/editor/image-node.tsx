"use client";

import * as React from "react";
import { $getNodeByKey } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, $isMegaImageNode, imageFromSerialized, MegaImageNode, type MegaImageValue, type SerializedMegaImageNode } from "@megaui/content";
import { $selectFollowingMegaBlock } from "./commands";

function EditableImage({ image, nodeKey }: { image: MegaImageValue; nodeKey: string }) {
  const [editor] = useLexicalComposerContext();
  const isChinese = typeof document !== "undefined" && document.documentElement.lang.startsWith("zh");
  const removeLabel = isChinese ? "删除图片" : "Remove image";
  return (
    <span
      aria-label={image.alt || (isChinese ? "图片" : "Image")}
      contentEditable={false}
      data-mega-content="image"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        event.currentTarget.focus();
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          const parent = node?.getParent();
          if ($isMegaBlockNode(parent)) $selectFollowingMegaBlock(parent);
        });
        queueMicrotask(() => editor.focus());
      }}
      role="group"
      style={{ display: "inline-block", maxWidth: "100%", position: "relative" }}
      tabIndex={0}
    >
      {/* Uploaded and explicitly entered image URLs are restricted to HTTP(S). */}
      <img alt={image.alt} loading="lazy" src={image.src} style={{ display: "block", height: "auto", maxWidth: "100%" }} />
      <button
        aria-label={removeLabel}
        data-mega-content="image-remove"
        onClick={() => editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if ($isMegaImageNode(node)) node.remove();
        })}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >×</button>
    </span>
  );
}

export class EditorImageNode extends MegaImageNode {
  static getType(): string { return super.getType() }
  static clone(node: EditorImageNode): EditorImageNode { return new EditorImageNode(node.getImage(), node.getKey()) }
  static importJSON(serialized: SerializedMegaImageNode): EditorImageNode { return new EditorImageNode(imageFromSerialized(serialized)) }
  createDOM(): HTMLElement { return document.createElement("span") }
  updateDOM(): false { return false }
  decorate(): React.JSX.Element { return <EditableImage image={this.getImage()} nodeKey={this.getKey()} /> }
}

export function $createEditorImageNode(image: MegaImageValue): EditorImageNode {
  return new EditorImageNode(image);
}
