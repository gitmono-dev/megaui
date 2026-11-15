// megaui:libs/mega/services/agent.ts@0ff3a9d (persistence slice)
// megaui:libs/database/schema/pg/mega-chat.ts@0ff3a9d (`mega_agent_threads`)
//
// Diff vs upstream (GC-03, registered on the EG-12 task card):
// - No `mega_agent_messages` metadata table: PK-05 froze the mega schema at
//   19 tables (`mega/schema.test.ts` AC1) with only `mega_agent_threads`
//   (thread metadata) for this domain, and this card's write set is
//   `packages/engine/src/services/agent/**` only — it cannot add a table or
//   column to `@megaui/database`. Every other content-backed domain (docs,
//   issues, CE-18 chat messages) stores one `mega_content` row *per entity
//   row* in its own metadata table; agent has no such per-message table, so
//   this module stores the thread's *entire* message list as one JSON
//   envelope in `mega_content` (`container_type = agent_message`,
//   `container_id = threadId`) — `{ messages: StoredAgentMessage[] }`. This
//   mirrors the CE-18 "segments envelope in body_json" precedent
//   (`mega-chat.ts` header) at thread granularity instead of message
//   granularity. A future card that adds a real `mega_agent_messages` table
//   can migrate this envelope without changing the `AgentThread` shape
//   callers see.
// - `appliedChunkIndexes` ledger per assistant message is megaui-only:
//   upstream persisted a complete answer in one write. This card's AC
//   requires idempotent incremental persistence (WA-06 SSE resume replays
//   chunks) — re-applying an already-seen `chunkIndex` is a no-op rather
//   than double-appending text.
// - Mutations serialize per-thread via `SELECT ... FOR UPDATE` on the
//   `mega_agent_threads` row (same lock-then-read-modify-write shape as
//   `issues.ts`/`docs.ts`), not a dedicated advisory-lock namespace — one
//   row already exists to lock for every thread.
import { randomUUID } from "node:crypto";
import { desc, eq, and } from "drizzle-orm";
import {
  megaAgentThreads,
  megaContent,
  megaContentContainerTypes,
  type Database,
} from "@megaui/database";
import type { AgentMessage, AgentThread, ChatSegment, Citation } from "@megaui/core";
import { MegaBadRequestError, MegaConflictError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { parsePagination } from "../../context";
import type { CreateThreadInput, ListThreadsInput, ListThreadsResult } from "./types";

interface StoredAgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  status: "complete" | "streaming";
  appliedChunkIndexes: number[];
  createdAt: string;
}

interface StoredThreadEnvelope {
  messages: StoredAgentMessage[];
}

function newAgentId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function requireActor(actorUserId: string | null | undefined): string {
  const id = actorUserId?.trim();
  if (!id) throw new MegaUnauthorizedError("A signed-in session is required");
  return id;
}

function toChatSegments(text: string): ChatSegment[] {
  return text.length > 0 ? [{ type: "text", text }] : [];
}

function toAgentMessage(stored: StoredAgentMessage): AgentMessage {
  return {
    id: stored.id,
    role: stored.role,
    body: stored.text,
    segments: toChatSegments(stored.text),
    citations: stored.citations,
    createdAt: stored.createdAt,
  };
}

function parseCitation(raw: unknown): Citation | null {
  if (!raw || typeof raw !== "object") return null;
  const citation = raw as Record<string, unknown>;
  if (typeof citation.id !== "string" || typeof citation.label !== "string" || typeof citation.url !== "string") {
    return null;
  }
  const kind = citation.kind;
  if (kind !== "file" && kind !== "cl" && kind !== "issue" && kind !== "doc" && kind !== "thread") return null;
  return {
    id: citation.id,
    kind,
    label: citation.label,
    url: citation.url,
    detail: typeof citation.detail === "string" ? citation.detail : undefined,
  };
}

function parseCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseCitation(entry))
    .filter((entry): entry is Citation => entry !== null);
}

function parseStoredMessage(raw: unknown): StoredAgentMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  if (typeof message.id !== "string") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  const appliedChunkIndexes = Array.isArray(message.appliedChunkIndexes)
    ? message.appliedChunkIndexes.filter((entry): entry is number => typeof entry === "number")
    : [];
  return {
    id: message.id,
    role: message.role,
    text: typeof message.text === "string" ? message.text : "",
    citations: parseCitations(message.citations),
    status: message.status === "streaming" ? "streaming" : "complete",
    appliedChunkIndexes,
    createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date(0).toISOString(),
  };
}

function parseEnvelope(raw: unknown): StoredThreadEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { messages: [] };
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return { messages: [] };
  return {
    messages: messages
      .map((entry) => parseStoredMessage(entry))
      .filter((entry): entry is StoredAgentMessage => entry !== null),
  };
}

export function createAgentThreadsStore(database: Database) {
  async function loadLockedThreadRow(tx: Database, threadId: string): Promise<{ id: string }> {
    const [row] = await tx
      .select({ id: megaAgentThreads.id })
      .from(megaAgentThreads)
      .where(eq(megaAgentThreads.id, threadId))
      .for("update")
      .limit(1);
    if (!row) throw new MegaNotFoundError("Agent thread", threadId);
    return row;
  }

  async function loadEnvelope(tx: Database, threadId: string): Promise<StoredThreadEnvelope> {
    const [row] = await tx
      .select({ bodyJson: megaContent.bodyJson })
      .from(megaContent)
      .where(
        and(
          eq(megaContent.containerType, megaContentContainerTypes.AGENT_MESSAGE),
          eq(megaContent.containerId, threadId),
        ),
      )
      .limit(1);
    return parseEnvelope(row?.bodyJson);
  }

  async function saveEnvelope(tx: Database, threadId: string, envelope: StoredThreadEnvelope, now: Date): Promise<void> {
    const bodyJson = envelope as unknown as Record<string, unknown>;
    await tx
      .insert(megaContent)
      .values({
        containerType: megaContentContainerTypes.AGENT_MESSAGE,
        containerId: threadId,
        bodyJson,
        bodyFormatVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [megaContent.containerType, megaContent.containerId],
        set: { bodyJson, updatedAt: now },
      });
  }

  async function loadThread(threadId: string): Promise<AgentThread> {
    const [row] = await database.select().from(megaAgentThreads).where(eq(megaAgentThreads.id, threadId)).limit(1);
    if (!row) throw new MegaNotFoundError("Agent thread", threadId);
    const envelope = await loadEnvelope(database, threadId);
    return {
      id: row.id,
      title: row.title,
      scopePackageId: row.scopePackageId ?? undefined,
      messages: envelope.messages.map(toAgentMessage),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function listThreads(input: ListThreadsInput = {}): Promise<ListThreadsResult> {
    const { offset, limit } = parsePagination(input.pagination);
    const rows = await database.select({ id: megaAgentThreads.id }).from(megaAgentThreads).orderBy(desc(megaAgentThreads.updatedAt));
    const page = rows.slice(offset, offset + limit);
    const items = await Promise.all(page.map((row) => loadThread(row.id)));
    return { items, total: rows.length, offset, limit };
  }

  async function createThread(input: CreateThreadInput, actorUserId: string | null | undefined): Promise<AgentThread> {
    requireActor(actorUserId);
    const title = input.title.trim();
    if (!title) throw new MegaBadRequestError("Agent thread title is required");
    const scopePackageId = input.scopePackageId?.trim() || null;
    const now = new Date();
    const id = newAgentId("agent_thread");

    await database.transaction(async (tx) => {
      await tx.insert(megaAgentThreads).values({ id, title, scopePackageId, createdAt: now, updatedAt: now });
      await saveEnvelope(tx, id, { messages: [] }, now);
    });

    return loadThread(id);
  }

  async function appendUserMessage(
    threadId: string,
    text: string,
    actorUserId: string | null | undefined,
  ): Promise<AgentMessage> {
    requireActor(actorUserId);
    const trimmed = text.trim();
    if (!trimmed) throw new MegaBadRequestError("Agent message body is required");

    const now = new Date();
    const message: StoredAgentMessage = {
      id: newAgentId("agent_msg"),
      role: "user",
      text: trimmed,
      citations: [],
      status: "complete",
      appliedChunkIndexes: [],
      createdAt: now.toISOString(),
    };

    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      envelope.messages.push(message);
      await saveEnvelope(tx, threadId, envelope, now);
      await tx.update(megaAgentThreads).set({ updatedAt: now }).where(eq(megaAgentThreads.id, threadId));
    });

    return toAgentMessage(message);
  }

  /** Creates the empty shell an in-flight assistant reply streams into (WA-06 incremental persistence). */
  async function startAssistantMessage(threadId: string): Promise<AgentMessage> {
    const now = new Date();
    const message: StoredAgentMessage = {
      id: newAgentId("agent_msg"),
      role: "assistant",
      text: "",
      citations: [],
      status: "streaming",
      appliedChunkIndexes: [],
      createdAt: now.toISOString(),
    };

    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      envelope.messages.push(message);
      await saveEnvelope(tx, threadId, envelope, now);
    });

    return toAgentMessage(message);
  }

  /**
   * Card AC1: idempotent incremental persistence. Re-applying a `chunkIndex`
   * already recorded for `messageId` is a no-op — safe for WA-06 to replay
   * on SSE resume without double-appending text.
   */
  async function appendAssistantChunk(
    threadId: string,
    messageId: string,
    chunkIndex: number,
    text: string,
  ): Promise<AgentMessage> {
    const now = new Date();
    let result: StoredAgentMessage | undefined;

    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      const target = envelope.messages.find((message) => message.id === messageId);
      if (!target) throw new MegaNotFoundError("Agent message", messageId);
      if (target.role !== "assistant") {
        throw new MegaBadRequestError("Only assistant messages accept streamed chunks");
      }
      if (target.status === "complete") {
        throw new MegaConflictError("Assistant message is already complete");
      }

      if (!target.appliedChunkIndexes.includes(chunkIndex)) {
        target.text += text;
        target.appliedChunkIndexes = [...target.appliedChunkIndexes, chunkIndex].sort((a, b) => a - b);
        await saveEnvelope(tx, threadId, envelope, now);
      }
      result = target;
    });

    return toAgentMessage(result as StoredAgentMessage);
  }

  async function completeAssistantMessage(
    threadId: string,
    messageId: string,
    citations: readonly Citation[] = [],
  ): Promise<AgentMessage> {
    const now = new Date();
    let result: StoredAgentMessage | undefined;

    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      const target = envelope.messages.find((message) => message.id === messageId);
      if (!target) throw new MegaNotFoundError("Agent message", messageId);
      if (target.role !== "assistant") {
        throw new MegaBadRequestError("Only assistant messages can be completed");
      }

      target.status = "complete";
      target.citations = [...citations];
      await saveEnvelope(tx, threadId, envelope, now);
      await tx.update(megaAgentThreads).set({ updatedAt: now }).where(eq(megaAgentThreads.id, threadId));
      result = target;
    });

    return toAgentMessage(result as StoredAgentMessage);
  }

  /**
   * Removes one message by id, if present (ER-05 P1 cleanup hook: drops the
   * empty placeholder `startAssistantMessage` created when the LLM call
   * that was meant to fill it in throws, so a transient LLM failure never
   * leaves a permanent empty assistant message in the thread). A no-op if
   * the message is already gone.
   */
  async function dropAssistantMessage(threadId: string, messageId: string): Promise<void> {
    const now = new Date();
    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      const next = envelope.messages.filter((message) => message.id !== messageId);
      if (next.length === envelope.messages.length) return;
      await saveEnvelope(tx, threadId, { messages: next }, now);
    });
  }

  /** Regenerate precondition: the last message must be an assistant reply, or there is nothing to regenerate. */
  async function dropTrailingAssistantMessage(threadId: string): Promise<AgentThread> {
    const now = new Date();

    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      const last = envelope.messages[envelope.messages.length - 1];
      if (!last || last.role !== "assistant") {
        throw new MegaBadRequestError("Nothing to regenerate: the last message is not an assistant reply");
      }
      envelope.messages = envelope.messages.slice(0, -1);
      await saveEnvelope(tx, threadId, envelope, now);
    });

    return loadThread(threadId);
  }

  /**
   * ER-05 P1 fix: `regenerate()`'s atomic replacement primitive. Unlike
   * `dropTrailingAssistantMessage` (which blindly drops "whatever is
   * trailing now"), this only replaces `oldMessageId`'s text/citations if
   * it is *still* the thread's trailing message and still an assistant
   * reply — both checked and mutated under the same `FOR UPDATE` thread
   * lock so a concurrent `ask()` that appended a new turn while the
   * caller's LLM call was in flight can never have its message silently
   * clobbered. Fails closed with `MegaConflictError` in that case; the
   * caller (`agent.ts`) leaves the store untouched and surfaces the
   * conflict rather than guessing which message to drop.
   */
  async function replaceAssistantMessage(
    threadId: string,
    oldMessageId: string,
    text: string,
    citations: readonly Citation[] = [],
  ): Promise<AgentMessage> {
    const now = new Date();
    let result: StoredAgentMessage | undefined;

    await database.transaction(async (tx) => {
      await loadLockedThreadRow(tx, threadId);
      const envelope = await loadEnvelope(tx, threadId);
      const last = envelope.messages[envelope.messages.length - 1];
      if (!last || last.id !== oldMessageId || last.role !== "assistant") {
        throw new MegaConflictError(
          "Cannot regenerate: the assistant reply being regenerated is no longer the thread's last message",
        );
      }
      const replaced: StoredAgentMessage = {
        ...last,
        text,
        citations: [...citations],
        status: "complete",
        appliedChunkIndexes: [],
      };
      envelope.messages = [...envelope.messages.slice(0, -1), replaced];
      await saveEnvelope(tx, threadId, envelope, now);
      await tx.update(megaAgentThreads).set({ updatedAt: now }).where(eq(megaAgentThreads.id, threadId));
      result = replaced;
    });

    return toAgentMessage(result as StoredAgentMessage);
  }

  return {
    listThreads,
    createThread,
    getThread: loadThread,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantChunk,
    completeAssistantMessage,
    dropAssistantMessage,
    dropTrailingAssistantMessage,
    replaceAssistantMessage,
  };
}

export type AgentThreadsStore = ReturnType<typeof createAgentThreadsStore>;
