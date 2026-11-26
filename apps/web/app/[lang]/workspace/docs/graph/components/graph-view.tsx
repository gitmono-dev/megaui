// megaui:apps/next-app/.../docs/graph/components/graph-view.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-13): lean xyflow+dagre graph; no MegaIcon.
"use client";

import dagre from "@dagrejs/dagre";
import { useMemo } from "react";
import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export type ContentGraphNodeKind = "doc" | "issue" | "cl";
export type ContentGraphEdgeKind = "wikilink" | "embed";

export type ContentGraphNode = {
  id: string;
  kind: ContentGraphNodeKind;
  entityId: string;
  entityNumber?: number;
  title: string;
  href: string;
};

export type ContentGraphEdge = {
  id: string;
  kind: ContentGraphEdgeKind;
  sourceNodeId: string;
  targetNodeId: string;
};

export type ContentLinkGraph = {
  nodes: ContentGraphNode[];
  edges: ContentGraphEdge[];
};

export interface ContentLinkGraphLabels {
  empty: string;
  graphAriaLabel: string;
  legendCl: string;
  legendDoc: string;
  legendEmbed: string;
  legendIssue: string;
  legendWikilink: string;
  title: string;
  issueAriaLabel: string;
  clAriaLabel: string;
}

export interface ContentLinkGraphViewProps {
  graph: ContentLinkGraph;
  labels: ContentLinkGraphLabels;
  onNavigate(href: string): void;
}

const NODE_WIDTH = 148;
const NODE_HEIGHT = 44;

function kindColor(kind: ContentGraphNode["kind"]): string {
  if (kind === "doc") return MEGA_TOKENS.accent;
  if (kind === "issue") return MEGA_TOKENS.success;
  return MEGA_TOKENS.merged;
}

type EntityNodeData = {
  node: ContentGraphNode;
  onActivate(): void;
  issueAriaLabel: string;
  clAriaLabel: string;
};

function entityAriaLabel(node: ContentGraphNode, issueAriaLabel: string, clAriaLabel: string): string {
  if (node.kind === "cl") return clAriaLabel.replace("{publicId}", node.entityId);
  if (node.kind === "issue" && node.entityNumber !== undefined) {
    return issueAriaLabel.replace("{number}", String(node.entityNumber));
  }
  return node.title;
}

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  const { node } = data;
  const color = kindColor(node.kind);
  const refLabel = entityAriaLabel(node, data.issueAriaLabel, data.clAriaLabel);
  return (
    <div
      aria-label={refLabel}
      data-kind={node.kind}
      data-mega-docs="graph-node"
      data-node-id={node.id}
      onClick={() => data.onActivate()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onActivate();
        }
      }}
      role="button"
      tabIndex={0}
      style={{
        alignItems: "center",
        background: MEGA_TOKENS.bg,
        border: `1.5px solid ${color}`,
        borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2)`,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        height: NODE_HEIGHT,
        justifyContent: "center",
        padding: `0 ${MEGA_SPACING_TOKENS[6]}`,
        width: NODE_WIDTH,
      }}
    >
      <Handle position={Position.Top} style={{ opacity: 0 }} type="target" />
      <span
        style={{
          color: MEGA_TOKENS.text,
          fontSize: "calc(var(--mega-density-font-size) - 1px)",
          fontWeight: 700,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.title}
      </span>
      <Handle position={Position.Bottom} style={{ opacity: 0 }} type="source" />
    </div>
  );
}

const nodeTypes = { megaEntity: EntityNode };

export function ContentLinkGraphView({ graph, labels, onNavigate }: ContentLinkGraphViewProps) {
  const layout = useMemo(() => {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 72 });
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    for (const node of graph.nodes) dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of graph.edges) dagreGraph.setEdge(edge.sourceNodeId, edge.targetNodeId);
    dagre.layout(dagreGraph);

    const flowNodes: Node<EntityNodeData>[] = graph.nodes.map((node) => {
      const position = dagreGraph.node(node.id);
      return {
        id: node.id,
        type: "megaEntity",
        position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
        data: {
          node,
          onActivate: () => onNavigate(node.href),
          issueAriaLabel: labels.issueAriaLabel,
          clAriaLabel: labels.clAriaLabel,
        },
        draggable: false,
        connectable: false,
      };
    });

    const flowEdges: Edge[] = graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      style: {
        stroke: edge.kind === "embed" ? MEGA_TOKENS.warning : MEGA_TOKENS.muted,
        strokeDasharray: edge.kind === "wikilink" ? "4 4" : undefined,
        strokeWidth: 1.5,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: MEGA_TOKENS.muted, height: 12, width: 12 },
    }));

    return { flowNodes, flowEdges };
  }, [graph, labels.clAriaLabel, labels.issueAriaLabel, onNavigate]);

  if (graph.nodes.length === 0) {
    return (
      <p data-mega-docs="graph-empty" style={{ color: MEGA_TOKENS.muted }}>
        {labels.empty}
      </p>
    );
  }

  return (
    <section
      data-mega-docs="graph-view"
      style={{
        background: MEGA_TOKENS.bg,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2)`,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          alignItems: "center",
          background: MEGA_TOKENS.subtle,
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          display: "flex",
          flexWrap: "wrap",
          gap: MEGA_SPACING_TOKENS[8],
          padding: MEGA_SPACING_TOKENS[8],
        }}
      >
        <strong>{labels.title}</strong>
        <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 2px)" }}>
          {labels.legendDoc} · {labels.legendIssue} · {labels.legendCl} · {labels.legendWikilink} · {labels.legendEmbed}
        </span>
      </header>
      <div aria-label={labels.graphAriaLabel} data-mega-docs="graph-flow" role="img" style={{ height: 420 }}>
        <ReactFlow
          edges={layout.flowEdges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          maxZoom={2}
          minZoom={0.35}
          nodes={layout.flowNodes}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          nodesDraggable={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: MEGA_TOKENS.subtle }}
        />
      </div>
    </section>
  );
}

export default ContentLinkGraphView;
