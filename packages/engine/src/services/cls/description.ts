// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (normalizeCLDescriptionJson / plainSummaryFromDescription)
//
// Diff vs upstream (registered on the EG-05 task card):
// - Upstream falls back to `importMarkdownOutline(trimmed, { semanticIssueRefs: true })`
//   for plain-text/markdown descriptions (headings, lists, `#N`/`!N` refs
//   promoted from markdown). megaui has not ported the markdown-outline
//   import pipeline (already a registered EG-01/EG-03 omission — see
//   `README.md`'s "Diffs vs upstream" tables). This module falls back to
//   the same line-based `importPlainText` used for CL comments instead:
//   headings/lists collapse to plain text blocks, but `#N`/`!N`/`@user`
//   tokens still promote to `mega-ref` nodes. Registered omission, not
//   silent drift.
// - `packCLDescriptionJson` / the `checksView` / `dependencyView` envelope
//   passthrough is out of scope (EG-06 owns checks/dependency-graph
//   persistence); `cls.ts` still preserves unknown envelope keys on write
//   so an EG-06 follow-up can add those keys without EG-05 clobbering them.
import { createEmptyMegaDocumentEditorStateJSON } from "@megaui/content";
import { importPlainText } from "./comment-body";

type DescriptionEnvelope = {
  root?: unknown;
  text?: unknown;
};

/** Normalize legacy text/envelope storage into a standalone Lexical editor state. */
export function normalizeCLDescriptionJson(raw: unknown): string {
  if (raw == null) return createEmptyMegaDocumentEditorStateJSON();
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return createEmptyMegaDocumentEditorStateJSON();
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      // Same as comment-body: JSON primitives are plain text, not Lexical.
      if (parsed !== null && typeof parsed === "object") {
        return normalizeCLDescriptionJson(parsed);
      }
      return importPlainText(trimmed);
    } catch {
      return importPlainText(trimmed);
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyMegaDocumentEditorStateJSON();
  }
  const envelope = raw as DescriptionEnvelope;
  if (envelope.root !== undefined) {
    return JSON.stringify({ root: envelope.root });
  }
  return typeof envelope.text === "string" && envelope.text.trim()
    ? importPlainText(envelope.text)
    : createEmptyMegaDocumentEditorStateJSON();
}

type SummaryWalkNode = {
  text?: unknown;
  ref?: { targetTitle?: unknown };
  children?: unknown;
};

/** Plain-text projection of a CL description envelope, used for `CL.description` / list search. */
export function plainSummaryFromDescription(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as DescriptionEnvelope;
  if (typeof record.text === "string") return record.text;

  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const walkNode = node as SummaryWalkNode;
    if (typeof walkNode.text === "string") texts.push(walkNode.text);
    if (typeof walkNode.ref?.targetTitle === "string") texts.push(walkNode.ref.targetTitle);
    if (Array.isArray(walkNode.children)) {
      for (const child of walkNode.children) walk(child);
    }
  };
  walk(record.root);
  const summary = texts.join(" ").replace(/\s+/g, " ").trim();
  return summary || undefined;
}
