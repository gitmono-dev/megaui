// megaui:apps/next-app/.../dep-graph.tsx@0ff3a9d (lean: no package navigate / MegaIcon)
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

import type { DepEdge, DepHeat, DepNode } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export interface DepGraphLabels {
  ciTime: string;
  columnDownstream: string;
  columnThis: string;
  columnUpstream: string;
  compileTime: string;
  graphAriaLabel: string;
  hotConsumer: string;
  legendDownstream: string;
  legendThis: string;
  legendUpstream: string;
  rebuilt: string;
  title: string;
}

export interface DepGraphProps {
  edges: readonly DepEdge[];
  labels: DepGraphLabels;
  nodes: readonly DepNode[];
}

const NODE_WIDTH = 120;
const NODE_HEIGHT = 40;

function kindColor(kind: DepNode["kind"]): string {
  if (kind === "this") return MEGA_TOKENS.accent;
  if (kind === "upstream") return MEGA_TOKENS.merged;
  return MEGA_TOKENS.success;
}

function heatStroke(heat: DepHeat): { color: string; dash?: string; width: number } {
  if (heat === "high") return { color: MEGA_TOKENS.danger, width: 2.2 };
  if (heat === "low") return { color: MEGA_TOKENS.warning, width: 1.5 };
  if (heat === "none") return { color: MEGA_TOKENS.muted, dash: "4 4", width: 1.5 };
  return { color: MEGA_TOKENS.muted, width: 1.5 };
}

type PackageNodeData = { depNode: DepNode };

function PackageNode({ data }: NodeProps<Node<PackageNodeData>>) {
  const { depNode } = data;
  const color = kindColor(depNode.kind);
  const isThis = depNode.kind === "this";
  return (
    <div
      data-kind={depNode.kind}
      data-mega-cls="dep-node"
      style={{
        alignItems: "center",
        background: isThis ? color : MEGA_TOKENS.bg,
        border: `${isThis ? 2 : 1.5}px solid ${color}`,
        borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2)`,
        display: "flex",
        flexDirection: "column",
        height: NODE_HEIGHT,
        justifyContent: "center",
        width: NODE_WIDTH,
      }}
    >
      <Handle position={Position.Left} style={{ opacity: 0 }} type="target" />
      <span
        style={{
          color: isThis ? MEGA_TOKENS.accentForeground : MEGA_TOKENS.text,
          fontSize: "calc(var(--mega-density-font-size) - 0.5px)",
          fontWeight: 700,
        }}
      >
        {depNode.label}
      </span>
      {depNode.kloc ? (
        <span
          style={{
            color: isThis ? MEGA_TOKENS.accentForeground : MEGA_TOKENS.muted,
            fontFamily: MEGA_TOKENS.fontMono,
            fontSize: "calc(var(--mega-density-font-size) - 3.5px)",
            opacity: 0.9,
          }}
        >
          {depNode.kloc}
        </span>
      ) : null}
      <Handle position={Position.Right} style={{ opacity: 0 }} type="source" />
    </div>
  );
}

const nodeTypes = { megaPackage: PackageNode };

/** ADR-WS-06: React Flow + dagre LR layout — three ranks (upstream / this / downstream). */
export function DepGraph({ edges, labels, nodes }: DepGraphProps) {
  const layout = useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "LR", nodesep: 42, ranksep: 120 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of edges) graph.setEdge(edge.from, edge.to);
    dagre.layout(graph);

    const flowNodes: Node<PackageNodeData>[] = nodes.map((depNode) => {
      const position = graph.node(depNode.id);
      return {
        id: depNode.id,
        type: "megaPackage",
        position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
        data: { depNode },
        draggable: false,
        connectable: false,
      };
    });

    const flowEdges: Edge[] = edges.map((depEdge) => {
      const stroke = heatStroke(depEdge.heat);
      return {
        id: depEdge.id,
        source: depEdge.from,
        target: depEdge.to,
        label: depEdge.via,
        labelStyle: { fill: MEGA_TOKENS.muted, fontFamily: "var(--mega-font-mono)", fontSize: 10 },
        labelBgStyle: { fill: "transparent" },
        style: { stroke: stroke.color, strokeDasharray: stroke.dash, strokeWidth: stroke.width },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke.color, height: 14, width: 14 },
      };
    });

    return { flowNodes, flowEdges };
  }, [edges, nodes]);

  const downstream = nodes.filter((node) => node.kind === "downstream");
  const hotEdges = edges.filter((edge) => edge.heat === "high");
  const hotLabel = hotEdges
    .map((edge) => nodes.find((node) => node.id === edge.to)?.label ?? edge.to)
    .join(", ");

  const legend = [
    { color: MEGA_TOKENS.merged, label: labels.legendUpstream },
    { color: MEGA_TOKENS.accent, label: labels.legendThis },
    { color: MEGA_TOKENS.success, label: labels.legendDownstream },
  ];

  return (
    <section
      data-mega-cls="dep-graph"
      style={{
        background: MEGA_TOKENS.bg,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2.5)`,
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
          fontSize: "calc(var(--mega-density-font-size) - 1px)",
          padding: MEGA_SPACING_TOKENS[8],
        }}
      >
        <span style={{ color: MEGA_TOKENS.text, fontWeight: 700 }}>{labels.title}</span>
        <span style={{ color: MEGA_TOKENS.muted }}>· {labels.compileTime}</span>
        <span style={{ flex: 1 }} />
        <span style={{ alignItems: "center", color: MEGA_TOKENS.muted, display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          {legend.map((entry) => (
            <span key={entry.label} style={{ alignItems: "center", display: "inline-flex", gap: MEGA_SPACING_TOKENS[4] }}>
              <span
                aria-hidden="true"
                style={{ background: entry.color, borderRadius: MEGA_SPACING_TOKENS[1], display: "inline-block", height: 8, width: 8 }}
              />
              {entry.label}
            </span>
          ))}
        </span>
      </header>

      <div style={{ position: "relative" }}>
        <div
          aria-hidden="true"
          style={{
            display: "flex",
            justifyContent: "space-between",
            left: 0,
            padding: `${MEGA_SPACING_TOKENS[8]} calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
            pointerEvents: "none",
            position: "absolute",
            right: 0,
            top: 0,
            zIndex: 4,
          }}
        >
          <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 3px)", fontWeight: 700 }}>
            {labels.columnUpstream}
          </span>
          <span style={{ color: MEGA_TOKENS.accent, fontSize: "calc(var(--mega-density-font-size) - 3px)", fontWeight: 700 }}>
            {labels.columnThis}
          </span>
          <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 3px)", fontWeight: 700 }}>
            {labels.columnDownstream}
          </span>
        </div>
        <div aria-label={labels.graphAriaLabel} data-mega-cls="dep-flow" role="img" style={{ height: 320 }}>
          <ReactFlow
            edges={layout.flowEdges}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            maxZoom={2}
            minZoom={0.4}
            nodes={layout.flowNodes}
            nodeTypes={nodeTypes}
            nodesConnectable={false}
            nodesDraggable={false}
            proOptions={{ hideAttribution: true }}
            style={{ background: MEGA_TOKENS.subtle }}
          />
        </div>
      </div>

      <footer
        data-mega-cls="dep-summary"
        style={{
          borderTop: `1px solid ${MEGA_TOKENS.border}`,
          color: MEGA_TOKENS.muted,
          display: "flex",
          flexWrap: "wrap",
          fontSize: "calc(var(--mega-density-font-size) - 1.5px)",
          gap: MEGA_SPACING_TOKENS[8],
          padding: MEGA_SPACING_TOKENS[8],
        }}
      >
        <span>{labels.rebuilt.replace("{count}", String(downstream.length))}</span>
        <span>
          · {labels.hotConsumer.replace("{count}", String(hotEdges.length)).replace("{name}", hotLabel || "—")}
        </span>
        <span>· {labels.ciTime.replace("{duration}", "—")}</span>
      </footer>
    </section>
  );
}

export default DepGraph;
