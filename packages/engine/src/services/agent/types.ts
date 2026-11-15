// megaui:libs/mega/services/agent.ts@0ff3a9d (input/output slice)
//
// Diff vs upstream (GC-03, registered on the EG-12 task card):
// - No credit/billing input shapes (SaaS 剥离; upstream's agent ask carried a
//   credit-cost estimate alongside the prompt). This card's `AskInput` is
//   just the user's message text.
// - `AskOutcome` / regenerate share one discriminated union that is
//   megaui-only: upstream always returned a generated answer (its only
//   "unavailable" path was the 402 credit gate this repo does not port).
//   ADR-ARCH-06 requires an explicit fail-closed "LLM not configured" state
//   instead of a fabricated answer (GC-07), so every orchestration entry
//   point returns `{ status: "answered" | "llm_disabled", thread }` rather
//   than throwing or silently degrading.
import type { AgentThread, Citation } from "@megaui/core";
import type { PaginationInput } from "../../context";

export interface CreateThreadInput {
  title: string;
  scopePackageId?: string;
}

export interface ListThreadsInput {
  pagination?: PaginationInput;
}

export interface ListThreadsResult {
  items: AgentThread[];
  total: number;
  offset: number;
  limit: number;
}

export interface AskInput {
  message: string;
}

/**
 * The reason string is operator-facing (GC-07/ER-11: names the missing
 * config, never a secret value). `"failed"` (ER-05 P1) is distinct from
 * `"llm_disabled"`: the LLM *is* configured but a specific call threw
 * (timeout, 5xx after exhausting `./llm.ts`'s bounded retry, etc.) — the
 * `thread` on a `"failed"` outcome never carries a leftover empty/streaming
 * assistant placeholder for the failed turn.
 */
export type AskOutcome =
  | { status: "answered"; thread: AgentThread }
  | { status: "llm_disabled"; thread: AgentThread; reason: string }
  | { status: "failed"; thread: AgentThread; reason: string };

export interface CompleteAssistantMessageInput {
  citations?: readonly Citation[];
}

/** openai-compatible chat message shape the LLM client accepts (role + plain text only — no tool calls ported). */
export interface AgentLlmMessage {
  role: "system" | "user" | "assistant";
  text: string;
}

export interface AgentLlmCompletion {
  text: string;
  finishReason: string;
}

/** Injected into `createAgentService` — `undefined` is the ADR-ARCH-06 fail-closed "not configured" state. */
export interface AgentLlmClient {
  complete(messages: readonly AgentLlmMessage[]): Promise<AgentLlmCompletion>;
}

/** `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` (ADR-ARCH-06). */
export interface AgentLlmEnv {
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
}

export interface AgentLlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}
