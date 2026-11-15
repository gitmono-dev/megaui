// megaui:apps/next-app/lib/mega-agent-stream.ts@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-06 / ADR-ARCH-06):
// - No credit pre-authorization, 402, or usage billing (SaaS 剥离).
// - LLM unconfigured → SSE `{ type: "llm_disabled" }` on HTTP 200 (GC-07),
//   never a fabricated assistant answer.
// - Uses `@megaui/engine` store primitives + openai-compatible `doStream`
//   (chunkIndex idempotent persistence via `appendAssistantChunk`).
// - Client abort (`request.signal`) drops the in-flight assistant placeholder.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentMessage, AgentThread } from "@megaui/core";
import {
  MegaBadRequestError,
  MegaNotFoundError,
  MegaUnauthorizedError,
  resolveAgentLlmConfig,
  type AgentLlmMessage,
} from "@megaui/engine";
import { z } from "zod";

import { resolveWebActor } from "@/lib/enterprise-session";
import { getAgentDomain } from "@/lib/engine";
import { mapMegaErrorToHttpResponse } from "../errors";
import { megaFailureResponse } from "../envelope";
import { segmentText } from "./shared";

const SYSTEM_PROMPT: AgentLlmMessage = {
  role: "system",
  text: "You are the megaui workspace agent. Answer concisely using the conversation so far.",
};

const LLM_DISABLED_REASON =
  "LLM is not configured (AI_BASE_URL / AI_API_KEY / AI_MODEL)";

/** Enterprise streams re-read the authoritative qualification at this cadence. */
export const AGENT_AUTH_REVALIDATION_INTERVAL_MS = 15_000;
/** The cadence leaves a bounded 30-second revocation-to-last-delta budget. */
export const AGENT_AUTH_MAX_REVOKE_LATENCY_MS = 30_000;

export function shouldRevalidateAgentAccess(
  lastValidatedAt: number,
  now = Date.now(),
): boolean {
  return now - lastValidatedAt >= AGENT_AUTH_REVALIDATION_INTERVAL_MS;
}

const askBodySchema = z.object({
  message: z.string().trim().min(1),
});

const regenerateBodySchema = z.object({
  messageId: z.string().trim().min(1).optional(),
});

export type AgentStreamEvent =
  | {
      type: "start";
      question?: AgentMessage;
      answer: AgentMessage;
      thread: AgentThread;
    }
  | { type: "delta"; text: string; answerId: string; chunkIndex: number }
  | { type: "done"; answer: AgentMessage; thread: AgentThread }
  | { type: "error"; code: string; message: string }
  | { type: "llm_disabled"; reason: string; thread: AgentThread };

export interface AgentStreamLlmClient {
  stream(
    messages: readonly AgentLlmMessage[],
    signal?: AbortSignal,
  ): AsyncIterable<string>;
}

/** `undefined` = production config; `null` = force llm_disabled (tests). */
let agentStreamLlmOverride: AgentStreamLlmClient | null | undefined = undefined;

export function setAgentStreamLlmClientForTests(
  client: AgentStreamLlmClient | null | undefined,
): void {
  agentStreamLlmOverride = client;
}

export function resetAgentStreamLlmClientForTests(): void {
  agentStreamLlmOverride = undefined;
}

function getAgentStreamLlmClientOverride(): AgentStreamLlmClient | null | undefined {
  return agentStreamLlmOverride;
}

function encodeSse(event: AgentStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function toLlmMessages(thread: AgentThread): AgentLlmMessage[] {
  return [
    SYSTEM_PROMPT,
    ...thread.messages
      .filter((message) => message.body !== undefined || message.segments.length > 0)
      .map((message) => ({ role: message.role, text: message.body ?? "" })),
  ];
}

function toPromptMessages(messages: readonly AgentLlmMessage[]) {
  return messages.map((message) =>
    message.role === "system"
      ? { role: "system" as const, content: message.text }
      : { role: message.role, content: [{ type: "text" as const, text: message.text }] },
  );
}

function createProductionStreamLlm(): AgentStreamLlmClient | null {
  const config = resolveAgentLlmConfig();
  if (!config) return null;
  const provider = createOpenAICompatible({
    name: "megaui-agent",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  const model = provider.chatModel(config.model);

  return {
    async *stream(messages, signal) {
      const result = await model.doStream({
        prompt: toPromptMessages(messages),
        abortSignal: signal,
      });
      for await (const part of result.stream) {
        if (part.type === "text-delta" && part.delta) {
          yield part.delta;
        }
      }
    },
  };
}

function resolveStreamLlm(): AgentStreamLlmClient | null {
  const override = getAgentStreamLlmClientOverride();
  if (override !== undefined) return override;
  return createProductionStreamLlm();
}

async function pumpLiveStream(input: {
  threadId: string;
  answerId: string;
  promptMessages: AgentLlmMessage[];
  question?: AgentMessage;
  startAnswer: AgentMessage;
  startThread: AgentThread;
  llm: AgentStreamLlmClient;
  signal: AbortSignal;
  headers: Headers;
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Regenerate: drop this prior assistant only after the replacement stream completes. */
  supersededAssistantId?: string;
}): Promise<void> {
  const encoder = new TextEncoder();
  const { store } = getAgentDomain();

  const write = (event: AgentStreamEvent) => {
    input.controller.enqueue(encoder.encode(encodeSse(event)));
  };

  write({
    type: "start",
    question: input.question,
    answer: input.startAnswer,
    thread: input.startThread,
  });

  let chunkIndex = 0;
  let lastValidatedAt = Date.now();
  try {
    for await (const delta of input.llm.stream(input.promptMessages, input.signal)) {
      if (input.signal.aborted) break;
      if (shouldRevalidateAgentAccess(lastValidatedAt)) {
        if (!(await resolveWebActor(input.headers))) {
          await store.dropAssistantMessage(input.threadId, input.answerId);
          return;
        }
        lastValidatedAt = Date.now();
      }
      if (!delta) continue;
      await store.appendAssistantChunk(input.threadId, input.answerId, chunkIndex, delta);
      if (input.signal.aborted) {
        await store.dropAssistantMessage(input.threadId, input.answerId);
        return;
      }
      write({ type: "delta", text: delta, answerId: input.answerId, chunkIndex });
      chunkIndex += 1;
    }

    if (input.signal.aborted) {
      await store.dropAssistantMessage(input.threadId, input.answerId);
      return;
    }
    if (shouldRevalidateAgentAccess(lastValidatedAt)) {
      if (!(await resolveWebActor(input.headers))) {
        await store.dropAssistantMessage(input.threadId, input.answerId);
        return;
      }
      lastValidatedAt = Date.now();
    }

    const answer = await store.completeAssistantMessage(input.threadId, input.answerId, []);
    if (input.supersededAssistantId) {
      await store.dropAssistantMessage(input.threadId, input.supersededAssistantId);
    }
    const thread = await store.getThread(input.threadId);
    write({ type: "done", answer, thread });
  } catch (error) {
    await store.dropAssistantMessage(input.threadId, input.answerId);
    const message = error instanceof Error ? error.message : "Agent stream failed";
    write({ type: "error", code: "AGENT_STREAM_ERROR", message });
  }
}

function llmDisabledStream(thread: AgentThread): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          encodeSse({ type: "llm_disabled", reason: LLM_DISABLED_REASON, thread }),
        ),
      );
      controller.close();
    },
  });
}

export async function handleAgentAskStream(
  request: Request,
  threadId: string,
  message: string,
  actorUserId: string,
): Promise<Response> {
  const { store } = getAgentDomain();
  const llm = resolveStreamLlm();

  const question = await store.appendUserMessage(threadId, message, actorUserId);
  let thread = await store.getThread(threadId);

  if (!llm) {
    return sseResponse(llmDisabledStream(thread));
  }

  const started = await store.startAssistantMessage(threadId);
  thread = await store.getThread(threadId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await pumpLiveStream({
          threadId,
          answerId: started.id,
          promptMessages: toLlmMessages(thread),
          question,
          startAnswer: started,
          startThread: thread,
          llm,
          signal: request.signal,
          headers: request.headers,
          controller,
        });
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}

export async function handleAgentRegenerateStream(
  request: Request,
  threadId: string,
  messageId?: string,
): Promise<Response> {
  const { store } = getAgentDomain();
  const llm = resolveStreamLlm();

  const before = await store.getThread(threadId);
  const trailing = before.messages.at(-1);
  if (!trailing || trailing.role !== "assistant") {
    throw new MegaBadRequestError(
      "Nothing to regenerate: the last message is not an assistant reply",
    );
  }
  if (messageId && trailing.id !== messageId) {
    throw new MegaBadRequestError(
      "Nothing to regenerate: the specified message is not the thread's last assistant reply",
    );
  }

  if (!llm) {
    return sseResponse(llmDisabledStream(before));
  }

  const promptMessages = toLlmMessages({
    ...before,
    messages: before.messages.slice(0, -1),
  });

  const supersededAssistantId = trailing.id;
  const started = await store.startAssistantMessage(threadId);
  const thread = await store.getThread(threadId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await pumpLiveStream({
          threadId,
          answerId: started.id,
          promptMessages,
          startAnswer: started,
          startThread: thread,
          llm,
          signal: request.signal,
          headers: request.headers,
          controller,
          supersededAssistantId,
        });
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}

/** POST /api/mega/agent/:threadId/{ask|regenerate} — returns SSE Response or JSON error Response. */
export async function maybeHandleAgentStreamPost(
  request: Request,
  segments: readonly string[],
  body: unknown,
): Promise<Response | undefined> {
  if (segments[0] !== "agent" || segments.length !== 3) return undefined;
  const action = segments[2];
  if (action !== "ask" && action !== "regenerate") return undefined;

  try {
    const actor = await resolveWebActor(request.headers);
    const actorUserId = actor?.userId;
    if (!actorUserId) {
      const { status, body: failureBody } = mapMegaErrorToHttpResponse(
        new MegaUnauthorizedError("Unauthorized"),
        request,
      );
      return megaFailureResponse(failureBody, status);
    }

    const threadId = segmentText(segments[1]);

    if (action === "ask") {
      const input = askBodySchema.parse(body);
      return handleAgentAskStream(request, threadId, input.message, actorUserId);
    }

    const input = regenerateBodySchema.parse(body ?? {});
    return handleAgentRegenerateStream(request, threadId, input.messageId);
  } catch (error) {
    if (error instanceof MegaNotFoundError) {
      const { status, body: failureBody } = mapMegaErrorToHttpResponse(error, request);
      return megaFailureResponse(failureBody, status);
    }
    if (error instanceof z.ZodError || error instanceof MegaBadRequestError) {
      const { status, body: failureBody } = mapMegaErrorToHttpResponse(error, request);
      return megaFailureResponse(failureBody, status);
    }
    throw error;
  }
}
