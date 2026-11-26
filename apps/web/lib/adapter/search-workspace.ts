// megaui:libs/mega/services/search.ts@0ff3a9d (workspace search composition)
//
// Diff vs upstream (GC-03 / WA-05):
// - Composes `@megaui/engine` English/CJK body search + title ranking over
//   docs/issues/cls domains (no mock store, no file tree — `files` is always
//   `[]`). ACL filtering uses docs ACL + chat channel access for body hits.

import { megaContentContainerTypes, megaDocComments, megaMessages } from "@megaui/database";
import type { CL, Doc, Issue } from "@megaui/core";
import {
  containsCjkScript,
  rankByTitleScore,
  searchCjk,
  searchEnglish,
  type SearchBodyHit,
} from "@megaui/engine";
import { getDb } from "@megaui/database";
import { eq } from "drizzle-orm";

import {
  getChatDomain,
  getClsDomain,
  getDocsDomain,
  getIssuesDomain,
} from "@/lib/engine";

export const SEARCH_GROUP_LIMIT = 6;

export const SEARCH_BODY_PER_KIND = 5;

export type WorkspaceBodyHitKind =
  | "doc"
  | "issue"
  | "cl"
  | "doc_comment"
  | "issue_comment"
  | "cl_comment"
  | "chat_message";

export interface WorkspaceBodyHit {
  kind: WorkspaceBodyHitKind;
  sourceId: string;
  blockId: string;
  title: string;
  parentTitle?: string;
  entityNumber?: number;
  publicId?: string;
  docId?: string;
  channelId?: string;
  snippet: string;
  highlightTerms: readonly string[];
}

export interface WorkspaceSearchBodyResults {
  docs: readonly WorkspaceBodyHit[];
  issues: readonly WorkspaceBodyHit[];
  cls: readonly WorkspaceBodyHit[];
  comments: readonly WorkspaceBodyHit[];
  messages: readonly WorkspaceBodyHit[];
}

export interface WorkspaceSearchResults {
  issues: readonly Pick<Issue, "id" | "number" | "title" | "state">[];
  cls: readonly Pick<CL, "id" | "number" | "publicId" | "title" | "state">[];
  docs: readonly Pick<Doc, "id" | "title" | "updatedAt">[];
  files: [];
  body: WorkspaceSearchBodyResults;
}

function emptyBodyResults(): WorkspaceSearchBodyResults {
  return { docs: [], issues: [], cls: [], comments: [], messages: [] };
}

export function emptyWorkspaceSearchResults(): WorkspaceSearchResults {
  return { issues: [], cls: [], docs: [], files: [], body: emptyBodyResults() };
}

function extractSearchHighlightTerms(rawQuery: string): string[] {
  return rawQuery
    .trim()
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
}

function buildBodySearchSnippet(text: string, rawQuery: string, maxLen = 96): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const terms = extractSearchHighlightTerms(rawQuery);
  const lower = trimmed.toLowerCase();
  let matchIndex = -1;
  let matchLength = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index === -1) continue;
    if (matchIndex === -1 || index < matchIndex) {
      matchIndex = index;
      matchLength = term.length;
    }
  }
  if (matchIndex === -1) {
    return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen - 1)}…`;
  }
  const radius = 48;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(trimmed.length, matchIndex + matchLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < trimmed.length ? "…" : "";
  return `${prefix}${trimmed.slice(start, end)}${suffix}`;
}

function sourceTypeToKind(sourceType: string): WorkspaceBodyHitKind | undefined {
  switch (sourceType) {
    case megaContentContainerTypes.DOC:
      return "doc";
    case megaContentContainerTypes.ISSUE:
      return "issue";
    case megaContentContainerTypes.CL:
      return "cl";
    case megaContentContainerTypes.DOC_COMMENT:
      return "doc_comment";
    case megaContentContainerTypes.ISSUE_COMMENT:
      return "issue_comment";
    case megaContentContainerTypes.CL_COMMENT:
      return "cl_comment";
    case megaContentContainerTypes.CHAT_MESSAGE:
      return "chat_message";
    default:
      return undefined;
  }
}

function groupBodyHits(hits: readonly WorkspaceBodyHit[]): WorkspaceSearchBodyResults {
  const grouped = emptyBodyResults();
  for (const hit of hits) {
    switch (hit.kind) {
      case "doc":
        (grouped.docs as WorkspaceBodyHit[]).push(hit);
        break;
      case "issue":
        (grouped.issues as WorkspaceBodyHit[]).push(hit);
        break;
      case "cl":
        (grouped.cls as WorkspaceBodyHit[]).push(hit);
        break;
      case "issue_comment":
      case "cl_comment":
      case "doc_comment":
        (grouped.comments as WorkspaceBodyHit[]).push(hit);
        break;
      case "chat_message":
        (grouped.messages as WorkspaceBodyHit[]).push(hit);
        break;
      default: {
        const _exhaustive: never = hit.kind;
        void _exhaustive;
      }
    }
  }
  return grouped;
}

function capBodyResults(grouped: WorkspaceSearchBodyResults): WorkspaceSearchBodyResults {
  return {
    docs: grouped.docs.slice(0, SEARCH_BODY_PER_KIND),
    issues: grouped.issues.slice(0, SEARCH_BODY_PER_KIND),
    cls: grouped.cls.slice(0, SEARCH_BODY_PER_KIND),
    comments: grouped.comments.slice(0, SEARCH_BODY_PER_KIND),
    messages: grouped.messages.slice(0, SEARCH_BODY_PER_KIND),
  };
}

async function canAccessBodyHit(
  hit: SearchBodyHit,
  kind: WorkspaceBodyHitKind,
  actorUserId: string | null,
): Promise<boolean> {
  if (!actorUserId?.trim()) return false;
  const docsDomain = getDocsDomain();

  switch (kind) {
    case "doc":
      return (await docsDomain.acl.canRead(hit.sourceId, actorUserId)).allow;
    case "doc_comment": {
      const database = getDb();
      const [comment] = await database
        .select({ docId: megaDocComments.docId })
        .from(megaDocComments)
        .where(eq(megaDocComments.id, hit.sourceId))
        .limit(1);
      if (!comment) return false;
      return (await docsDomain.acl.canRead(comment.docId, actorUserId)).allow;
    }
    case "chat_message": {
      const database = getDb();
      const [row] = await database
        .select({ channelId: megaMessages.channelId })
        .from(megaMessages)
        .where(eq(megaMessages.id, hit.sourceId))
        .limit(1);
      if (!row) return false;
      try {
        await getChatDomain().members.assertCanAccessChannel(row.channelId, actorUserId);
        return true;
      } catch {
        return false;
      }
    }
    default:
      return true;
  }
}

async function resolveBodyHit(
  hit: SearchBodyHit,
  rawQuery: string,
  actorUserId: string | null,
): Promise<WorkspaceBodyHit | null> {
  const kind = sourceTypeToKind(hit.sourceType);
  if (!kind) return null;
  if (!(await canAccessBodyHit(hit, kind, actorUserId))) return null;

  const docsDomain = getDocsDomain();
  const { issues } = getIssuesDomain();
  const { cls } = getClsDomain();

  const snippet = buildBodySearchSnippet(hit.textSummary, rawQuery);
  const highlightTerms = extractSearchHighlightTerms(rawQuery);

  switch (kind) {
    case "doc": {
      try {
        const doc = await docsDomain.docs.getDoc(hit.sourceId, actorUserId);
        return {
          kind,
          sourceId: hit.sourceId,
          blockId: hit.blockId,
          title: doc.title,
          snippet,
          highlightTerms,
        };
      } catch {
        return null;
      }
    }
    case "issue": {
      const rows = await issues.listIssues({}, actorUserId);
      const issue = rows.items.find((row) => row.id === hit.sourceId);
      if (!issue) return null;
      return {
        kind,
        sourceId: hit.sourceId,
        blockId: hit.blockId,
        title: issue.title,
        entityNumber: issue.number,
        snippet,
        highlightTerms,
      };
    }
    case "cl": {
      const rows = await cls.listCLs({}, actorUserId);
      const cl = rows.find((row) => row.id === hit.sourceId);
      if (!cl) return null;
      return {
        kind,
        sourceId: hit.sourceId,
        blockId: hit.blockId,
        title: cl.title,
        publicId: cl.publicId,
        entityNumber: cl.number,
        snippet,
        highlightTerms,
      };
    }
    default:
      return {
        kind,
        sourceId: hit.sourceId,
        blockId: hit.blockId,
        title: hit.textSummary.slice(0, 80) || hit.sourceId,
        snippet,
        highlightTerms,
      };
  }
}

async function searchWorkspaceBody(
  rawQuery: string,
  actorUserId: string | null,
): Promise<WorkspaceSearchBodyResults> {
  const query = rawQuery.trim();
  if (!query) return emptyBodyResults();

  const database = getDb();
  const hits = containsCjkScript(query)
    ? await searchCjk(database, { query, perKind: SEARCH_BODY_PER_KIND })
    : await searchEnglish(database, { query, total: SEARCH_BODY_PER_KIND * 5 });

  const resolved = (
    await Promise.all(hits.map((hit) => resolveBodyHit(hit, query, actorUserId)))
  ).filter((hit): hit is WorkspaceBodyHit => hit !== null);

  return capBodyResults(groupBodyHits(resolved));
}

async function searchWorkspaceTitles(
  rawQuery: string,
  actorUserId: string | null,
  limit = SEARCH_GROUP_LIMIT,
): Promise<Pick<WorkspaceSearchResults, "issues" | "cls" | "docs" | "files">> {
  const query = rawQuery.trim();
  if (!query) return { issues: [], cls: [], docs: [], files: [] };

  const docsDomain = getDocsDomain();
  const { issues } = getIssuesDomain();
  const { cls } = getClsDomain();

  const [docRows, issueRows, clRows] = await Promise.all([
    docsDomain.docs.listDocs(actorUserId),
    issues.listIssues({}, actorUserId),
    cls.listCLs({}, actorUserId),
  ]);

  return {
    issues: rankByTitleScore(query, issueRows.items)
      .slice(0, limit)
      .map(({ item }) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        state: item.state,
      })),
    cls: rankByTitleScore(query, clRows)
      .slice(0, limit)
      .map(({ item }) => ({
        id: item.id,
        publicId: item.publicId,
        number: item.number,
        title: item.title,
        state: item.state,
      })),
    docs: rankByTitleScore(query, docRows)
      .slice(0, limit)
      .map(({ item }) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
      })),
    files: [],
  };
}

/**
 * Cross-entity workspace search: title/number groups plus FTS body hits.
 * An effectively empty query yields empty groups.
 */
export async function searchWorkspace(
  rawQuery: string,
  actorUserId: string | null,
  limit = SEARCH_GROUP_LIMIT,
): Promise<WorkspaceSearchResults> {
  const query = rawQuery.trim();
  if (!query) return emptyWorkspaceSearchResults();

  const [titles, body] = await Promise.all([
    searchWorkspaceTitles(query, actorUserId, limit),
    searchWorkspaceBody(query, actorUserId),
  ]);

  return { ...titles, body };
}
