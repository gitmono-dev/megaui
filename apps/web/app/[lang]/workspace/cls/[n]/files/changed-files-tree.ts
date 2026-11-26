import { compareByDirectoryFirstThenName, type CLFile } from "@megaui/core";
import type { FileTreeNode } from "@megaui/ui/file-tree";

/** Index only paths in this change. File and directory entries can share a path across revisions. */
export function buildChangedFilesTree(files: readonly CLFile[]) {
  const nodes: FileTreeNode[] = [];
  const childrenByDirectory = new Map<string, FileTreeNode[]>();
  const filesByPath = new Map<string, CLFile>();

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name || filesByPath.has(file.path)) continue;
    filesByPath.set(file.path, file);

    let children = nodes;
    let directory = "";
    for (const part of parts) {
      directory = directory ? `${directory}/${part}` : part;
      let entries = childrenByDirectory.get(directory);
      if (!entries) {
        entries = [];
        childrenByDirectory.set(directory, entries);
        children.push({ kind: "directory", name: part, path: directory, children: entries });
      }
      children = entries;
    }
    children.push({ kind: "file", name, path: file.path });
  }

  nodes.sort(compareByDirectoryFirstThenName);
  for (const entries of childrenByDirectory.values()) entries.sort(compareByDirectoryFirstThenName);
  return { nodes, filesByPath };
}
