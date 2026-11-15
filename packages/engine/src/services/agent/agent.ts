// megaui:libs/mega/services/agent.ts@0ff3a9d (ask/regenerate orchestration slice)
//
// Diff vs upstream (GC-03, registered on the EG-12 task card):
// - No credit pre-authorization/deduction (SaaS 剥离; upstream's `askAgent`
//   deducted credits before calling DeepSeek and 402'd when the balance was
//   insufficient). This orchestration has no billing gate at all.
// - SSE streaming itself is WA-06's job (`Out of scope` on this card) — this
//   module exposes the *building blocks* WA-06 streams over: start an
//   assistant message, call the LLM once (non-streaming `doGenerate`;
//   WA-06 fans the single completion out as SSE chunks), append/complete.
//   `ask`/`regenerate` here run that whole sequence synchronously and
//   return the final thread state; a route that wants incremental delivery
//   calls the store primitives (re-exported from `./index`) directly
//   instead of this convenience wrapper.
// - ADR-ARCH-06 fail-closed: when no `AgentLlmClient` was injected (LLM not
//   configured), `ask` still persists the user's message (that happened —
//   it is a fact) but returns `{ status: "llm_disabled" }` without creating
//   *any* assistant message. GC-07 forbids fabricating an answer, so this
//   deliberately does not persist a placeholder "assistant" reply either.
// - `regenerate` checks LLM availability *before* dropping the previous
//   assistant reply, so a thread never loses its last answer just because
//   the LLM happens to be unconfigured at regenerate time.
// - ER-05 P1: `llm.complete` throwing (vs. returning) is a distinct
//   fail-closed path from `llm_disabled` — `runAssistantTurn` cleans up the
//   placeholder `startAssistantMessage` it created rather than leaving a
//   permanent empty/streaming assistant message, and `regenerate` never
//   mutates the store until the *new* completion has already succeeded,
//   so a failed regenerate leaves the prior answer untouched instead of
//   losing it.
// - ER-05 P1: `regenerate` captures the trailing assistant message's id
//   *before* calling the LLM, then replaces that specific id (via
//   `store.replaceAssistantMessage`, atomic + `FOR UPDATE`-locked) instead
//   of dropping "whatever is trailing now" after the LLM call returns — a
//   concurrent `ask()` that appended a new turn while the LLM call was in
//   flight must not have its message clobbered by this regenerate; the
//   store call fails closed with `MegaConflictError` in that case.
import type { AgentThread } from "@megaui/core";
import type { Database } from "@megaui/database";
import { MegaBadRequestError, MegaUnauthorizedError } from "../../errors";
import { createAgentThreadsStore } from "./store";
import type {
  AgentLlmClient,
  AgentLlmCompletion,
  AgentLlmMessage,
  AskInput,
  AskOutcome,
  CreateThreadInput,
  ListThreadsInput,
  ListThreadsResult,
} from "./types";

const LLM_DISABLED_REASON = "LLM is not configured (AI_BASE_URL / AI_API_KEY / AI_MODEL)";

const SYSTEM_PROMPT: AgentLlmMessage = {
  role: "system",
  text: "You are the megaui workspace agent. Answer concisely using the conversation so far.",
};

function requireActor(actorUserId: string | null | undefined): string {
  const id = actorUserId?.trim();
  if (!id) throw new MegaUnauthorizedError("A signed-in session is required");
  return id;
}

function toLlmMessages(thread: AgentThread): AgentLlmMessage[] {
  return [
    SYSTEM_PROMPT,
    ...thread.messages
      .filter((message) => message.body !== undefined || message.segments.length > 0)
      .map((message) => ({ role: message.role, text: message.body ?? "" })),
  ];
}

/** Operator-facing failure reason (GC-07/ER-11: never a secret value) — `./llm.ts` already scrubs the underlying error to status/timeout text. */
function llmFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : "Agent LLM request failed";
}

export function createAgentService(database: Database, llm: AgentLlmClient | undefined) {
  const store = createAgentThreadsStore(database);

  async function runAssistantTurn(threadId: string, promptMessages: AgentLlmMessage[]): Promise<AskOutcome> {
    if (!llm) {
      const thread = await store.getThread(threadId);
      return { status: "llm_disabled", thread, reason: LLM_DISABLED_REASON };
    }

    const started = await store.startAssistantMessage(threadId);
    try {
      const completion = await llm.complete(promptMessages);
      await store.appendAssistantChunk(threadId, started.id, 0, completion.text);
      await store.completeAssistantMessage(threadId, started.id, []);
    } catch (error) {
      // Never leave the empty/streaming placeholder behind — a failed turn
      // must look like the turn never started, not like an answer that
      // silently came back blank.
      await store.dropAssistantMessage(threadId, started.id);
      const thread = await store.getThread(threadId);
      return { status: "failed", thread, reason: llmFailureReason(error) };
    }

    const thread = await store.getThread(threadId);
    return { status: "answered", thread };
  }

  async function ask(threadId: string, input: AskInput, actorUserId: string | null | undefined): Promise<AskOutcome> {
    requireActor(actorUserId);
    await store.appendUserMessage(threadId, input.message, actorUserId);
    const thread = await store.getThread(threadId);
    return runAssistantTurn(threadId, toLlmMessages(thread));
  }

  async function regenerate(threadId: string, actorUserId: string | null | undefined): Promise<AskOutcome> {
    requireActor(actorUserId);

    if (!llm) {
      const thread = await store.getThread(threadId);
      return { status: "llm_disabled", thread, reason: LLM_DISABLED_REASON };
    }

    const before = await store.getThread(threadId);
    const trailing = before.messages.at(-1);
    if (!trailing || trailing.role !== "assistant") {
      throw new MegaBadRequestError("Nothing to regenerate: the last message is not an assistant reply");
    }
    // Captured *before* the LLM call so the eventual replace targets this
    // exact message, not "whatever happens to be trailing" once the call
    // returns (ER-05 P1: a concurrent ask() can append a new turn while
    // this LLM call is in flight).
    const targetMessageId = trailing.id;

    // Ask the LLM for the replacement *before* touching the store — if this
    // throws, the store is never touched and the prior assistant reply is
    // left exactly as it was (no snapshot/restore needed because nothing
    // was ever dropped).
    let completion: AgentLlmCompletion;
    try {
      completion = await llm.complete(toLlmMessages({ ...before, messages: before.messages.slice(0, -1) }));
    } catch (error) {
      return { status: "failed", thread: before, reason: llmFailureReason(error) };
    }

    // Atomically replace *that specific* message id under a thread lock —
    // `replaceAssistantMessage` fails closed with `MegaConflictError` if a
    // concurrent ask() moved the trailing message out from under
    // `targetMessageId` while the LLM call above was in flight, instead of
    // silently dropping/clobbering that concurrent turn.
    await store.replaceAssistantMessage(threadId, targetMessageId, completion.text, []);

    const thread = await store.getThread(threadId);
    return { status: "answered", thread };
  }

  return {
    listThreads: (input?: ListThreadsInput): Promise<ListThreadsResult> => store.listThreads(input),
    getThread: (threadId: string): Promise<AgentThread> => store.getThread(threadId),
    createThread: (input: CreateThreadInput, actorUserId: string | null | undefined): Promise<AgentThread> =>
      store.createThread(input, actorUserId),
    ask,
    regenerate,
    isLlmConfigured: (): boolean => llm !== undefined,
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
