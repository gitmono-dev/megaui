import type { TreeNode } from "@megaui/core";
import { defaultExpandedPaths, MegaFileTree, type FileTreeNode } from "@megaui/ui/file-tree";
import { MEGA_TOKENS } from "@megaui/ui/tokens";

import { ancestorPaths, toFileTreeNodes } from "../lib/code-path-tree";

interface CodePathTreeProps {
  readonly activePath: string;
  readonly branchName: string | undefined;
  readonly nodes: readonly TreeNode[];
  readonly treeAriaLabel: string;
  readonly onDirectoryToggle: (path: string, expanded: boolean) => void;
  readonly onSelect: (node: FileTreeNode) => void;
}

export function CodePathTree({
  activePath,
  branchName,
  nodes,
  treeAriaLabel,
  onDirectoryToggle,
  onSelect,
}: CodePathTreeProps) {
  const fileTreeNodes = toFileTreeNodes(nodes);
  const expandedPaths = defaultExpandedPaths(fileTreeNodes);
  for (const path of ancestorPaths(activePath)) expandedPaths.add(path);

  return (
    <aside
      data-mega-code="tree"
      style={{ borderRight: `1px solid ${MEGA_TOKENS.border}`, overflow: "auto" }}
    >
      <MegaFileTree
        activePath={activePath}
        branchName={branchName}
        defaultExpanded={expandedPaths}
        labels={{ treeAriaLabel }}
        nodes={fileTreeNodes}
        onDirectoryToggle={onDirectoryToggle}
        onSelect={onSelect}
        width="100%"
      />
    </aside>
  );
}
