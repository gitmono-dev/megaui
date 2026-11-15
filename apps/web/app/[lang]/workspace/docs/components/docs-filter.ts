import type { Doc, DocTag, Folder } from "@megaui/core";

export const UNSORTED_FOLDER_ID = "__unsorted__";

export type DocsScope =
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "folder"; folderId: string }
  | { kind: "tag"; tagId: string };

export type DocsSort = "updated" | "title";

function folderDisplayName(folderId: string): string {
  const parts = folderId.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderId;
}

/** Derive sidebar catalogs from live docs — no fixture tag/folder tables. */
export function catalogsFromDocs(
  docs: readonly Doc[],
  unsortedLabel: string,
): { folders: Folder[]; tags: DocTag[] } {
  const folders = new Map<string, Folder>();
  const tags = new Map<string, DocTag>();
  for (const doc of docs) {
    if (doc.folderId && !folders.has(doc.folderId)) {
      folders.set(doc.folderId, {
        id: doc.folderId,
        name: folderDisplayName(doc.folderId),
        path: doc.folderId,
      });
    }
    for (const tag of doc.tags) {
      if (!tags.has(tag.id)) tags.set(tag.id, tag);
    }
  }
  return {
    folders: [{ id: UNSORTED_FOLDER_ID, name: unsortedLabel, path: "/" }, ...folders.values()],
    tags: [...tags.values()],
  };
}

export function previewLines(doc: Doc): readonly string[] {
  if (doc.preview.length > 0) return doc.preview;
  const excerpt = doc.excerpt.trim();
  if (!excerpt) return [];
  return excerpt
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** Scope + search predicate (title / excerpt / tag names / author). */
export function filterDocs(docs: readonly Doc[], scope: DocsScope, search: string): Doc[] {
  const query = search.trim().toLocaleLowerCase();
  return docs.filter((doc) => {
    switch (scope.kind) {
      case "all":
        break;
      case "starred":
        if (!doc.starred) return false;
        break;
      case "folder":
        if (scope.folderId === UNSORTED_FOLDER_ID) {
          if (doc.folderId) return false;
        } else if (doc.folderId !== scope.folderId) {
          return false;
        }
        break;
      case "tag":
        if (!doc.tags.some((tag) => tag.id === scope.tagId)) return false;
        break;
      default: {
        const exhaustive: never = scope;
        return exhaustive;
      }
    }
    if (!query) return true;
    const haystack = [
      doc.title,
      doc.excerpt,
      doc.author.displayName,
      doc.author.username,
      ...doc.tags.map((tag) => tag.name),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
}

/** Updated-desc recency (default) or locale-aware title order. */
export function sortDocs(docs: readonly Doc[], sort: DocsSort): Doc[] {
  const list = [...docs];
  if (sort === "title") return list.sort((left, right) => left.title.localeCompare(right.title, "zh-Hans-CN"));
  return list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
