import type { TreeNode } from "@megaui/core";
import { sortTreeNodesByKindThenName } from "@megaui/core";
import type { FileTreeNode } from "@megaui/ui/file-tree";

export function toFileTreeNodes(nodes: readonly TreeNode[]): FileTreeNode[] {
  return nodes.map((node) => ({
    name: node.name,
    path: node.path,
    kind: node.kind,
    children: node.children ? toFileTreeNodes(node.children) : undefined,
  }));
}

export function ancestorPaths(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function mergeTreeNodes(
  nodes: readonly TreeNode[],
  childrenByPath: ReadonlyMap<string, readonly TreeNode[]>,
): TreeNode[] {
  return sortTreeNodesByKindThenName(
    nodes.map((node) => {
      if (node.kind !== "directory") return node;
      const loadedChildren = childrenByPath.get(node.path);
      if (!loadedChildren) return node;
      return { ...node, children: mergeTreeNodes(loadedChildren, childrenByPath) };
    }),
  );
}

export function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children && path.startsWith(`${node.path}/`)) {
      const child = findNode(node.children, path);
      if (child) return child;
    }
  }
  return undefined;
}
