import type { AgentThread } from "@megaui/core";

export interface AgentThreadListPage {
  readonly items: AgentThread[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}
