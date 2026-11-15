import type { Database } from "@megaui/database";
import { createAgentService, type AgentService } from "./agent";
import { createAgentLlmClient, resolveAgentLlmConfig, type CreateAgentLlmClientOptions } from "./llm";
import { createAgentThreadsStore, type AgentThreadsStore } from "./store";
import type { AgentLlmEnv } from "./types";

export { createAgentService, type AgentService } from "./agent";
export { createAgentLlmClient, resolveAgentLlmConfig, type AgentLlmRetryConfig, type CreateAgentLlmClientOptions } from "./llm";
export { createAgentThreadsStore, type AgentThreadsStore } from "./store";
export type {
  AgentLlmClient,
  AgentLlmCompletion,
  AgentLlmConfig,
  AgentLlmEnv,
  AgentLlmMessage,
  AskInput,
  AskOutcome,
  CompleteAssistantMessageInput,
  CreateThreadInput,
  ListThreadsInput,
  ListThreadsResult,
} from "./types";

export interface AgentDomain {
  agent: AgentService;
  store: AgentThreadsStore;
}

/**
 * Wires the agent-domain service against one `Database` (EG-12).
 * `llmEnv` defaults to `process.env`; when `AI_BASE_URL`/`AI_API_KEY`/
 * `AI_MODEL` are not all set, `agent.ask`/`regenerate` fail closed with
 * `{ status: "llm_disabled" }` (ADR-ARCH-06) instead of throwing.
 */
export function createAgentDomain(
  database: Database,
  llmEnv?: AgentLlmEnv,
  llmClientOptions?: CreateAgentLlmClientOptions,
): AgentDomain {
  const config = resolveAgentLlmConfig(llmEnv);
  const llm = config ? createAgentLlmClient(config, llmClientOptions) : undefined;
  const agent = createAgentService(database, llm);
  const store = createAgentThreadsStore(database);
  return { agent, store };
}
