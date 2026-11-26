"use client";

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { $getRoot, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_LOW, PASTE_COMMAND, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isMegaBlockNode, parseRoamImageSource, type MegaBlockNode } from "@megaui/content";
import { $getSelectedMegaBlock, $selectFollowingMegaBlock } from "../commands";
import { $createEditorImageNode } from "../image-node";
import { OPEN_IMAGE_DIALOG_COMMAND } from "./image-command";

export interface ImagePluginLabels {
  dialog: string;
  url: string;
  alt: string;
  file: string;
  insert: string;
  cancel: string;
  invalid: string;
  uploading: string;
}

function findBlock(blockId: string, nodes: readonly LexicalNode[]): MegaBlockNode | null {
  for (const node of nodes) {
    if (!$isMegaBlockNode(node)) continue;
    if (node.getBlockId() === blockId) return node;
    const child = findBlock(blockId, node.getChildren());
    if (child) return child;
  }
  return null;
}

/** A pasted Roam image uses the standard Markdown image form. */
export function parseRoamImage(text: string): { src: string; alt: string } | null {
  const image = parseRoamImageSource(text.trim());
  if (!image) return null;
  try {
    const url = new URL(image.src);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return { src: url.toString(), alt: image.alt };
  } catch {
    return null;
  }
}

export function ImagePlugin({ labels, upload, onError }: {
  labels: ImagePluginLabels;
  upload: (file: File) => Promise<string>;
  onError: (error: unknown) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [blockId, setBlockId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const insert = useCallback((targetId: string, src: string, imageAlt: string) => {
    editor.update(() => {
      const block = findBlock(targetId, $getRoot().getChildren());
      if (!block) return;
      block.append($createEditorImageNode({ src, alt: imageAlt }));
      $selectFollowingMegaBlock(block);
    });
    setBlockId(null);
    setUrl("");
    setAlt("");
    setInvalid(false);
    queueMicrotask(() => editor.focus());
  }, [editor]);

  const insertFile = useCallback(async (targetId: string, file: File) => {
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    try {
      const src = await upload(file);
      insert(targetId, src, alt || file.name);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }, [alt, insert, onError, upload]);

  useEffect(() => editor.registerCommand(OPEN_IMAGE_DIALOG_COMMAND, (targetId) => {
    setBlockId(targetId);
    return true;
  }, COMMAND_PRIORITY_LOW), [editor]);

  useEffect(() => editor.registerCommand(PASTE_COMMAND, (event) => {
    if (!("clipboardData" in event)) return false;
    const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith("image/"));
    const targetId = $getSelectedMegaBlock()?.getBlockId();
    if (!targetId) return false;
    if (!file) {
      const image = parseRoamImage(event.clipboardData?.getData("text/plain") ?? "");
      if (!image) return false;
      event.preventDefault();
      insert(targetId, image.src, image.alt);
      return true;
    }
    event.preventDefault();
    void insertFile(targetId, file);
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor, insert, insertFile]);

  if (!blockId || typeof document === "undefined") return null;
  return createPortal(
    <div aria-label={labels.dialog} data-mega-content="image-dialog" role="dialog">
      <form onSubmit={(event) => {
        event.preventDefault();
        try {
          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid image URL");
          insert(blockId, parsed.toString(), alt);
        } catch {
          setInvalid(true);
        }
      }}>
        <h2>{labels.dialog}</h2>
        <label>{labels.url}<input autoFocus onChange={(event) => { setUrl(event.target.value); setInvalid(false); }} type="url" value={url} /></label>
        <label>{labels.alt}<input onChange={(event) => setAlt(event.target.value)} type="text" value={alt} /></label>
        <label>{labels.file}<input accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void insertFile(blockId, file);
        }} type="file" /></label>
        {invalid ? <p role="alert">{labels.invalid}</p> : null}
        {busy ? <p role="status">{labels.uploading}</p> : null}
        <div data-mega-content="image-dialog-actions">
          <button onClick={() => setBlockId(null)} type="button">{labels.cancel}</button>
          <button disabled={busy || !url.trim()} type="submit">{labels.insert}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
