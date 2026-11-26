// megaui:libs/mega/services/repos/cls-repo.ts@0ff3a9d (CLDependencyView / getCLDependencyGraph / designDependencySnapshot)
//
// Diff vs upstream (registered on the EG-06 task card):
// - Same DEBT-04 fixture omission as checks.ts: `getCLDependencyGraph`
//   returns an empty graph until `setCLDependencyGraph` writes one — no
//   process-global design snapshot.
// - Upstream never annotates the graph. This module adds
//   `detectDependencyCycles` (EG-06 AC3 "dep-graph 数据闭环（环检测输入给前端布局）"):
//   a pure DFS over `nodes`/`edges` that returns every simple cycle as
//   layout input for the frontend's xyflow graph. It never rejects a
//   cyclic graph — real package dependency graphs can be legitimately
//   cyclic; this is layout-hint data, not validation.
import { eq, inArray } from "drizzle-orm";
import { megaClPublicIds, megaCls, type Database } from "@megaui/database";
import type { ApiChange, DepEdge, DepNode, RelatedCL, SymbolUsage } from "@megaui/core";
import { MegaNotFoundError } from "../../errors";
import { assertWorkspaceMember } from "./authz";
import { loadClEnvelope, writeClEnvelope } from "./envelope";

/** Persisted under mega_content (container=cl) as body_json.dependencyView. */
export interface CLDependencyView {
  nodes: readonly DepNode[];
  edges: readonly DepEdge[];
  apiChanges: readonly ApiChange[];
  relatedCLs: readonly RelatedCL[];
  symbolUsage: readonly SymbolUsage[];
  symbolIndexUpdatedAt?: string;
}

/** `CLDependencyView` plus derived cycle-detection input for the frontend graph layout (EG-06 AC3). */
export interface CLDependencyGraphResult extends CLDependencyView {
  /** Each entry is one simple cycle as an ordered list of node ids (start not repeated at the end). */
  cycles: readonly (readonly string[])[];
}

export interface SetCLDependencyGraphInput {
  nodes: readonly DepNode[];
  edges: readonly DepEdge[];
  apiChanges?: readonly ApiChange[];
  relatedCLs?: readonly RelatedCL[];
  symbolUsage?: readonly SymbolUsage[];
  symbolIndexUpdatedAt?: string;
}

function emptyDependencyView(): CLDependencyView {
  return { nodes: [], edges: [], apiChanges: [], relatedCLs: [], symbolUsage: [] };
}

function parseDependencyView(raw: unknown): CLDependencyView | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) return undefined;
  return {
    nodes: record.nodes as DepNode[],
    edges: record.edges as DepEdge[],
    apiChanges: Array.isArray(record.apiChanges) ? (record.apiChanges as ApiChange[]) : [],
    relatedCLs: Array.isArray(record.relatedCLs) ? (record.relatedCLs as RelatedCL[]) : [],
    symbolUsage: Array.isArray(record.symbolUsage) ? (record.symbolUsage as SymbolUsage[]) : [],
    symbolIndexUpdatedAt: typeof record.symbolIndexUpdatedAt === "string" ? record.symbolIndexUpdatedAt : undefined,
  };
}

/**
 * Cap on distinct simple cycles returned (bounds the worst-case blowup of
 * exhaustively re-walking every path in a densely-connected graph). Never
 * hit in practice for the small single-CL graph size this card handles —
 * not a whole-repo module graph.
 */
const MAX_CYCLES = 64;

/**
 * Enumerates simple cycles in a directed node/edge graph via exhaustive DFS
 * that treats every node as a search root and never permanently blocks a
 * node from being revisited — only `onStack` membership marks a back-edge
 * (cycle). A prior revision short-circuited on a *global* `visited` set,
 * which silently dropped any cycle whose nodes were also reachable from an
 * earlier DFS root (e.g. two cycles sharing a node, a "diamond" shape) —
 * once a shared node was marked visited from the first cycle's traversal,
 * the second cycle's back-edge through that node was never explored.
 * Removing that guard trades some redundant re-traversal for actually
 * finding every simple cycle; `MAX_CYCLES` bounds how much re-traversal a
 * pathological input can force. A self-loop (`from === to`) is reported as
 * a length-1 cycle.
 */
export function detectDependencyCycles(
  nodes: readonly DepNode[],
  edges: readonly DepEdge[],
): readonly (readonly string[])[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  const onStack: string[] = [];
  const onStackSet = new Set<string>();

  function cycleKey(cycle: readonly string[]): string {
    // Rotate to the lexicographically smallest id so the same cycle found
    // from different start nodes/edges dedupes to one entry.
    let bestIndex = 0;
    for (let index = 1; index < cycle.length; index += 1) {
      const candidate = cycle[index];
      const best = cycle[bestIndex];
      if (candidate !== undefined && best !== undefined && candidate < best) bestIndex = index;
    }
    return [...cycle.slice(bestIndex), ...cycle.slice(0, bestIndex)].join(">");
  }

  function visit(nodeId: string): void {
    onStack.push(nodeId);
    onStackSet.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (cycles.length >= MAX_CYCLES) break;
      if (onStackSet.has(next)) {
        const stackIndex = onStack.indexOf(next);
        const cycle = onStack.slice(stackIndex);
        const key = cycleKey(cycle);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
        continue;
      }
      visit(next);
    }
    onStack.pop();
    onStackSet.delete(nodeId);
  }

  for (const node of adjacency.keys()) {
    if (cycles.length >= MAX_CYCLES) break;
    visit(node);
  }
  return cycles;
}

async function requireClId(database: Database, number: number): Promise<string> {
  const [row] = await database.select({ id: megaCls.id }).from(megaCls).where(eq(megaCls.number, number)).limit(1);
  if (!row) throw new MegaNotFoundError("CL", number);
  return row.id;
}

export async function getCLDependencyGraph(database: Database, number: number): Promise<CLDependencyGraphResult> {
  const clId = await requireClId(database, number);
  const envelope = await loadClEnvelope(database, clId);
  const view = parseDependencyView(envelope.dependencyView) ?? emptyDependencyView();
  return projectDependencyGraph(database, view);
}

async function projectDependencyGraph(database: Database, view: CLDependencyView): Promise<CLDependencyGraphResult> {
  const numbers = [...new Set(view.relatedCLs.map((related) => related.number))];
  const rows = numbers.length
    ? await database.select().from(megaClPublicIds).where(inArray(megaClPublicIds.number, numbers))
    : [];
  const byNumber = new Map(rows.map((row) => [row.number, row.publicId]));
  return {
    ...view,
    relatedCLs: view.relatedCLs.map((related) => ({ ...related, publicId: byNumber.get(related.number) })),
    cycles: detectDependencyCycles(view.nodes, view.edges),
  };
}

export async function setCLDependencyGraph(
  database: Database,
  number: number,
  input: SetCLDependencyGraphInput,
  actorUserId: string | null | undefined,
): Promise<CLDependencyGraphResult> {
  await assertWorkspaceMember(database, actorUserId);
  const view: CLDependencyView = {
    nodes: input.nodes,
    edges: input.edges,
    apiChanges: input.apiChanges ?? [],
    relatedCLs: input.relatedCLs ?? [],
    symbolUsage: input.symbolUsage ?? [],
    symbolIndexUpdatedAt: input.symbolIndexUpdatedAt,
  };
  await database.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: megaCls.id })
      .from(megaCls)
      .where(eq(megaCls.number, number))
      .for("update")
      .limit(1);
    if (!row) throw new MegaNotFoundError("CL", number);
    const envelope = await loadClEnvelope(tx, row.id);
    const now = new Date();
    await writeClEnvelope(tx, row.id, { ...envelope, dependencyView: view }, now);
    await tx.update(megaCls).set({ updatedAt: now }).where(eq(megaCls.id, row.id));
  });
  return projectDependencyGraph(database, view);
}
