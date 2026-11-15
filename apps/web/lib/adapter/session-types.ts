/** Session fixture shape for WA-15 (fixture BFF; no engine persistence). */
export type SessionFixture = {
  id: string;
  title: string;
  status: "completed" | "running";
  threadRef: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; latencyMs: number };
  decisions: { id: string; label: string; rationale: string }[];
  evidence: { id: string; label: string; href: string }[];
  citations: { id: string; kind: "file" | "cl" | "issue" | "doc" | "thread"; label: string; url: string }[];
};
