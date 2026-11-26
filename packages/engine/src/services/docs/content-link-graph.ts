// megaui:libs/mega/services/content-link-graph.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-03 task card):
// - No `MEGA_DOCS_DATA_BACKEND=mock` branch / mock catalog build (DEBT-04).
// - No `filterByDefaultOpenAcl` default-open shim. Doc nodes/edges are
//   filtered fail-closed against the actor's ACL read grant
//   (`createAclService.canRead`); issue/CL nodes stay unfiltered because
//   those domains have no ACL model yet (EG-04/EG-05 — registered omission
//   on this card, not a silent default-open reproduction).
// - No `CONTENT_LINK_GRAPH_QUERY_BUDGET` test-seam counter / injectable
//   database override — this card's test suite asserts behavior against a
//   real throwaway PG database instead of a query-count budget.
// - Single PG dialect (ADR-ARCH-02).
import { inArray, isNull } from "drizzle-orm";
import {
  megaClComments,
  megaContent,
  megaContentContainerTypes,
  megaContentLinks,
  megaContentLinkTargetKinds,
  megaDocComments,
  megaDocs,
  megaIssueComments,
  megaIssues,
  type Database,
} from "@megaui/database";
import type { AclService } from "../acl";
import { extractEmbedsFromEditorState } from "./embed";
import { decodeBlockTargetId, documentCLReferences, selectDocumentCLs } from "./links";

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

type EntityCatalog = {
  docs: Map<string, { title: string }>;
  issuesById: Map<string, { number: number; title: string }>;
  issuesByNumber: Map<number, { id: string; title: string }>;
  clsByRef: Map<string, { publicId: string; title: string }>;
  issueComments: Map<string, { issueNumber: number }>;
  clComments: Map<string, { clNumber: number }>;
  docComments: Map<string, { docId: string }>;
};

function nodeId(kind: ContentGraphNodeKind, key: string): string {
  return `${kind}:${key}`;
}

function hrefForNode(kind: ContentGraphNodeKind, entityId: string, entityNumber?: number): string {
  switch (kind) {
    case "doc":
      return `/docs/${encodeURIComponent(entityId)}`;
    case "issue":
      return `/issues/${entityNumber ?? entityId}`;
    case "cl":
      return `/cls/${entityId}`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function buildNode(
  kind: ContentGraphNodeKind,
  entityId: string,
  title: string,
  entityNumber?: number,
): ContentGraphNode | null {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return null;
  const key = String(entityNumber ?? entityId);
  return {
    id: nodeId(kind, key),
    kind,
    entityId,
    entityNumber,
    title: normalizedTitle,
    href: hrefForNode(kind, entityId, entityNumber),
  };
}

function resolveCLNode(catalog: EntityCatalog, ref: string): ContentGraphNode | null {
  const cl = catalog.clsByRef.get(ref);
  return cl ? buildNode("cl", cl.publicId, cl.title) : null;
}

function resolveTargetNode(catalog: EntityCatalog, targetKind: string, targetId: string): ContentGraphNode | null {
  switch (targetKind) {
    case megaContentLinkTargetKinds.DOC: {
      const doc = catalog.docs.get(targetId);
      return doc ? buildNode("doc", targetId, doc.title) : null;
    }
    case megaContentLinkTargetKinds.ISSUE: {
      const byId = catalog.issuesById.get(targetId);
      if (byId) return buildNode("issue", targetId, byId.title, byId.number);
      const asNumber = Number(targetId);
      const byNumber = Number.isFinite(asNumber) ? catalog.issuesByNumber.get(asNumber) : undefined;
      return byNumber ? buildNode("issue", byNumber.id, byNumber.title, asNumber) : null;
    }
    case megaContentLinkTargetKinds.CL:
      return resolveCLNode(catalog, targetId);
    case megaContentLinkTargetKinds.BLOCK: {
      // BLOCK targets are persisted as `${targetDocId}:${targetBlockId}`
      // (see `links.ts` `encodeBlockTargetId`) since `target_id` alone can't
      // disambiguate the same blockId across two different docs.
      const decoded = decodeBlockTargetId(targetId);
      if (!decoded) return null;
      const doc = catalog.docs.get(decoded.targetDocId);
      return doc ? buildNode("doc", decoded.targetDocId, doc.title) : null;
    }
    default:
      return null;
  }
}

function resolveSourceNode(catalog: EntityCatalog, sourceType: string, sourceId: string): ContentGraphNode | null {
  switch (sourceType) {
    case megaContentContainerTypes.DOC: {
      const doc = catalog.docs.get(sourceId);
      return doc ? buildNode("doc", sourceId, doc.title) : null;
    }
    case megaContentContainerTypes.ISSUE: {
      const byId = catalog.issuesById.get(sourceId);
      if (byId) return buildNode("issue", sourceId, byId.title, byId.number);
      const asNumber = Number(sourceId);
      const byNumber = Number.isFinite(asNumber) ? catalog.issuesByNumber.get(asNumber) : undefined;
      return byNumber ? buildNode("issue", byNumber.id, byNumber.title, asNumber) : null;
    }
    case megaContentContainerTypes.CL:
      return resolveCLNode(catalog, sourceId);
    case megaContentContainerTypes.ISSUE_COMMENT: {
      const comment = catalog.issueComments.get(sourceId);
      if (!comment) return null;
      const issue = catalog.issuesByNumber.get(comment.issueNumber);
      return issue ? buildNode("issue", issue.id, issue.title, comment.issueNumber) : null;
    }
    case megaContentContainerTypes.CL_COMMENT: {
      const comment = catalog.clComments.get(sourceId);
      if (!comment) return null;
      return resolveCLNode(catalog, String(comment.clNumber));
    }
    case megaContentContainerTypes.DOC_COMMENT: {
      const comment = catalog.docComments.get(sourceId);
      if (!comment) return null;
      const doc = catalog.docs.get(comment.docId);
      return doc ? buildNode("doc", comment.docId, doc.title) : null;
    }
    default:
      return null;
  }
}

function upsertNode(map: Map<string, ContentGraphNode>, node: ContentGraphNode | null): void {
  if (!node) return;
  map.set(node.id, node);
}

function addEdge(
  edges: Map<string, ContentGraphEdge>,
  kind: ContentGraphEdgeKind,
  sourceNodeId: string,
  targetNodeId: string,
): void {
  if (sourceNodeId === targetNodeId) return;
  const id = `${kind}:${sourceNodeId}->${targetNodeId}`;
  if (edges.has(id)) return;
  edges.set(id, { id, kind, sourceNodeId, targetNodeId });
}

function parseBodyJson(bodyJson: unknown): string {
  if (typeof bodyJson === "string") return bodyJson;
  return JSON.stringify(bodyJson ?? { root: { children: [] } });
}

function buildGraphFromCatalog(
  catalog: EntityCatalog,
  wikilinkRows: readonly { sourceType: string; sourceId: string; targetKind: string; targetId: string }[],
  embedRows: readonly { sourceType: string; sourceId: string; targetDocId: string }[],
): ContentLinkGraph {
  const nodes = new Map<string, ContentGraphNode>();
  const edges = new Map<string, ContentGraphEdge>();

  // Render the full entity catalog (docs/issues/CLs), not only edge endpoints.
  for (const [docId, doc] of catalog.docs) upsertNode(nodes, buildNode("doc", docId, doc.title));
  for (const [issueId, issue] of catalog.issuesById) {
    upsertNode(nodes, buildNode("issue", issueId, issue.title, issue.number));
  }
  for (const cl of new Set(catalog.clsByRef.values())) {
    upsertNode(nodes, buildNode("cl", cl.publicId, cl.title));
  }

  wikilinkRows.forEach((row) => {
    const source = resolveSourceNode(catalog, row.sourceType, row.sourceId);
    const target = resolveTargetNode(catalog, row.targetKind, row.targetId);
    if (!source || !target) return;
    upsertNode(nodes, source);
    upsertNode(nodes, target);
    addEdge(edges, "wikilink", source.id, target.id);
  });

  embedRows.forEach((row) => {
    const source = resolveSourceNode(catalog, row.sourceType, row.sourceId);
    const targetDoc = catalog.docs.get(row.targetDocId);
    if (!source || !targetDoc) return;
    const target = buildNode("doc", row.targetDocId, targetDoc.title);
    if (!target) return;
    upsertNode(nodes, source);
    upsertNode(nodes, target);
    addEdge(edges, "embed", source.id, target.id);
  });

  return {
    nodes: [...nodes.values()].sort((left, right) => left.title.localeCompare(right.title)),
    edges: [...edges.values()],
  };
}

async function filterGraphByDocAcl(
  acl: AclService,
  actorUserId: string | null | undefined,
  graph: ContentLinkGraph,
): Promise<ContentLinkGraph> {
  const docNodeIds = graph.nodes.filter((node) => node.kind === "doc");
  const readable = new Map<string, boolean>();
  for (const node of docNodeIds) {
    readable.set(node.id, (await acl.canRead(node.entityId, actorUserId)).allow);
  }
  const nodes = graph.nodes.filter((node) => node.kind !== "doc" || readable.get(node.id));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId),
  );
  return { nodes, edges };
}

/** CE-111: aggregate workspace link graph for docs/issues/CLs (wikilink + embed edges). */
export async function getContentLinkGraph(
  database: Database,
  acl: AclService,
  actorUserId: string | null | undefined,
): Promise<ContentLinkGraph> {
  const linkRows = await database
    .select({
      sourceType: megaContentLinks.sourceType,
      sourceId: megaContentLinks.sourceId,
      targetKind: megaContentLinks.targetKind,
      targetId: megaContentLinks.targetId,
    })
    .from(megaContentLinks);

  const docRows = await database
    .select({ id: megaDocs.id, title: megaDocs.title })
    .from(megaDocs)
    .where(isNull(megaDocs.deletedAt));

  const issueRows = await database
    .select({ id: megaIssues.id, number: megaIssues.number, title: megaIssues.title })
    .from(megaIssues);

  const clRows = await selectDocumentCLs(database);

  const issueCommentRows = await database
    .select({ id: megaIssueComments.id, issueNumber: megaIssueComments.issueNumber })
    .from(megaIssueComments);

  const clCommentRows = await database
    .select({ id: megaClComments.id, clNumber: megaClComments.clNumber })
    .from(megaClComments);

  const docCommentRows = await database
    .select({ id: megaDocComments.id, docId: megaDocComments.docId })
    .from(megaDocComments);

  const contentRows = await database
    .select({
      containerType: megaContent.containerType,
      containerId: megaContent.containerId,
      bodyJson: megaContent.bodyJson,
    })
    .from(megaContent)
    .where(
      inArray(megaContent.containerType, [
        megaContentContainerTypes.DOC,
        megaContentContainerTypes.ISSUE,
        megaContentContainerTypes.CL,
      ]),
    );

  const clsByRef: EntityCatalog["clsByRef"] = new Map();
  for (const cl of clRows) {
    for (const ref of documentCLReferences(cl)) clsByRef.set(ref, cl);
  }

  const catalog: EntityCatalog = {
    docs: new Map(docRows.map((row) => [row.id, { title: row.title }])),
    issuesById: new Map(issueRows.map((row) => [row.id, { number: row.number, title: row.title }])),
    issuesByNumber: new Map(issueRows.map((row) => [row.number, { id: row.id, title: row.title }])),
    clsByRef,
    issueComments: new Map(issueCommentRows.map((row) => [row.id, { issueNumber: row.issueNumber }])),
    clComments: new Map(clCommentRows.map((row) => [row.id, { clNumber: row.clNumber }])),
    docComments: new Map(docCommentRows.map((row) => [row.id, { docId: row.docId }])),
  };

  const embedRows: Array<{ sourceType: string; sourceId: string; targetDocId: string }> = [];
  for (const row of contentRows) {
    const body = parseBodyJson(row.bodyJson);
    for (const embed of extractEmbedsFromEditorState(body)) {
      embedRows.push({ sourceType: row.containerType, sourceId: row.containerId, targetDocId: embed.targetDocId });
    }
  }

  const graph = buildGraphFromCatalog(catalog, linkRows, embedRows);
  return filterGraphByDocAcl(acl, actorUserId, graph);
}
