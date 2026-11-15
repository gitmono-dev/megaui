// megaui-only (WA-15): SSE-only ask/regenerate client matching WA-06 BFF.

import type { AgentMessage, AgentThread } from "@megaui/core";
import { MegaApiError } from "@megaui/ui/query";

export type AgentClientStreamEvent =
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

function megaUrl(segments: readonly string[]): string {
  return `/api/mega/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

async function throwIfMegaFailure(response: Response): Promise<void> {
  if (response.ok) return;
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string } }
    | undefined;
  throw new MegaApiError(
    response.status,
    payload?.error?.code ?? "MEGA_REQUEST_FAILED",
    payload?.error?.message ?? `Mega request failed (${response.status})`,
  );
}

async function consumeSse(
  response: Response,
  onEvent?: (event: AgentClientStreamEvent) => void,
): Promise<AgentClientStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new MegaApiError(500, "MEGA_INVALID_RESPONSE", "Missing SSE body");
  const decoder = new TextDecoder();
  let buffer = "";
  let last: AgentClientStreamEvent | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .map((part) => part.trim())
        .find((part) => part.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      const event = JSON.parse(payload) as AgentClientStreamEvent;
      last = event;
      onEvent?.(event);
      if (event.type === "done" || event.type === "error" || event.type === "llm_disabled") {
        return event;
      }
    }
  }

  if (!last || (last.type !== "done" && last.type !== "error" && last.type !== "llm_disabled")) {
    throw new MegaApiError(500, "MEGA_INVALID_RESPONSE", "Agent stream ended without a terminal event");
  }
  return last;
}

export async function postAgentAsk(input: {
  threadId: string;
  message: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentClientStreamEvent) => void;
}): Promise<AgentClientStreamEvent> {
  const response = await fetch(megaUrl(["agent", input.threadId, "ask"]), {
    method: "POST",
    credentials: "same-origin",
    signal: input.signal,
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: input.message }),
  });
  await throwIfMegaFailure(response);
  return consumeSse(response, input.onEvent);
}

export async function postAgentRegenerate(input: {
  threadId: string;
  messageId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentClientStreamEvent) => void;
}): Promise<AgentClientStreamEvent> {
  const response = await fetch(megaUrl(["agent", input.threadId, "regenerate"]), {
    method: "POST",
    credentials: "same-origin",
    signal: input.signal,
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.messageId ? { messageId: input.messageId } : {}),
  });
  await throwIfMegaFailure(response);
  return consumeSse(response, input.onEvent);
}
