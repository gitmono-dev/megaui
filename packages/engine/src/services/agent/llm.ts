// megaui:libs/mega/services/agent.ts@0ff3a9d (LLM call slice)
//
// Diff vs upstream (GC-03, registered on the EG-12 task card):
// - Upstream called the DeepSeek SDK directly. ADR-ARCH-06 replaces that
//   with `@ai-sdk/openai-compatible`'s `LanguageModelV4.doGenerate` — one
//   config surface (`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`) for any
//   OpenAI-compatible endpoint, no DeepSeek-specific branch.
// - Bounded retry (ER-10) is this module's own responsibility: the AI SDK
//   provider does not retry — it classifies failures (`APICallError` +
//   `isRetryable`, or an abort/timeout `DOMException`) and this wrapper
//   applies capped exponential backoff only to transient failures.
//   Deterministic failures (4xx, config/schema errors) fail on the first
//   attempt.
// - Duck-types the AI SDK error marker (`error.name === "AI_APICallError"`)
//   instead of importing `@ai-sdk/provider` — that package is already a
//   declared dependency of `@ai-sdk/openai-compatible` and the marker is a
//   stable cross-version check (see `AISDKError.isInstance`'s own
//   `Symbol.for` design upstream); importing it directly would add a
//   second explicit dependency for a single boolean/number read.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { MegaInternalError } from "../../errors";
import type { AgentLlmClient, AgentLlmCompletion, AgentLlmConfig, AgentLlmEnv, AgentLlmMessage } from "./types";

export function resolveAgentLlmConfig(
  env: AgentLlmEnv = process.env as AgentLlmEnv,
): AgentLlmConfig | null {
  const baseURL = env.AI_BASE_URL?.trim();
  const apiKey = env.AI_API_KEY?.trim();
  const model = env.AI_MODEL?.trim();
  if (!baseURL || !apiKey || !model) return null;
  return { baseURL, apiKey, model };
}

interface AICallErrorLike extends Error {
  statusCode?: number;
  isRetryable?: boolean;
}

function isAiApiCallError(error: unknown): error is AICallErrorLike {
  return error instanceof Error && error.name === "AI_APICallError";
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** ER-10: timeouts, 429/5xx (`APICallError.isRetryable`), and network aborts are transient; everything else is deterministic. */
function isTransientLlmError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return true;
  if (isAiApiCallError(error)) return error.isRetryable === true;
  return false;
}

function describeLlmError(error: unknown): string {
  if (isAiApiCallError(error)) {
    return `status=${error.statusCode ?? "network"} ${error.message}`;
  }
  if (isAbortOrTimeoutError(error)) return `timeout (${(error as Error).name})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

function extractText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function extractFinishReason(finishReason: unknown): string {
  if (typeof finishReason === "string") return finishReason;
  if (finishReason && typeof finishReason === "object" && "unified" in finishReason) {
    const unified = (finishReason as { unified?: unknown }).unified;
    if (typeof unified === "string") return unified;
  }
  return "unknown";
}

function toPromptMessages(messages: readonly AgentLlmMessage[]) {
  return messages.map((message) =>
    message.role === "system"
      ? { role: "system" as const, content: message.text }
      : { role: message.role, content: [{ type: "text" as const, text: message.text }] },
  );
}

export interface AgentLlmRetryConfig {
  /** ER-10 default ceiling: bounded retry, ≤ 5 attempts. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** ER-10: total retry budget, default ≤ 30 minutes. */
  maxTotalDelayMs?: number;
}

export interface CreateAgentLlmClientOptions {
  /** Test hook — stubs the HTTP layer so retry/timeout/5xx paths never touch the network. */
  fetch?: typeof globalThis.fetch;
  retry?: AgentLlmRetryConfig;
  requestTimeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_MAX_TOTAL_DELAY_MS = 30 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Card AC3: openai-compatible call, stub-tested (success / timeout / 5xx bounded retry, ER-10). */
export function createAgentLlmClient(
  config: AgentLlmConfig,
  options: CreateAgentLlmClientOptions = {},
): AgentLlmClient {
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxTotalDelayMs = options.retry?.maxTotalDelayMs ?? DEFAULT_MAX_TOTAL_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const provider = createOpenAICompatible({
    name: "megaui-agent",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    fetch: options.fetch,
  });
  const model = provider.chatModel(config.model);

  async function complete(messages: readonly AgentLlmMessage[]): Promise<AgentLlmCompletion> {
    if (messages.length === 0) {
      throw new MegaInternalError("Agent LLM request requires at least one message");
    }
    const prompt = toPromptMessages(messages);

    let elapsedDelayMs = 0;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await model.doGenerate({
          prompt,
          abortSignal: AbortSignal.timeout(requestTimeoutMs),
        });
        const text = extractText(result.content as { type: string; text?: string }[]);
        return { text, finishReason: extractFinishReason(result.finishReason) };
      } catch (error) {
        lastError = error;
        const transient = isTransientLlmError(error);
        const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
        const withinBudget = elapsedDelayMs + delayMs <= maxTotalDelayMs;
        if (!transient || attempt >= maxAttempts || !withinBudget) {
          throw new MegaInternalError(
            `Agent LLM request failed after ${attempt} attempt(s): ${describeLlmError(error)}`,
          );
        }
        elapsedDelayMs += delayMs;
        await sleep(delayMs);
      }
    }
    throw new MegaInternalError(`Agent LLM request failed: ${describeLlmError(lastError)}`);
  }

  return { complete };
}
