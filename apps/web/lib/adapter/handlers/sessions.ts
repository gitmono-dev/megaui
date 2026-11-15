// megaui-only (WA-15): sessions fixture view (no engine SessionThread persistence).

import { MegaNotFoundError } from "@megaui/engine";

import type { SessionFixture } from "../session-types";
import { registerMegaRoute, type MegaDispatchContext } from "../dispatch";
import { invalidRoute, segmentText } from "./shared";

const FIXTURES: Record<string, SessionFixture> = {
  sess_demo: {
    id: "sess_demo",
    title: "Investigate flaky CI",
    status: "completed",
    threadRef: "refs/ai/sess_demo",
    usage: { inputTokens: 1200, outputTokens: 480, totalTokens: 1680, latencyMs: 2400 },
    decisions: [
      {
        id: "dec_1",
        label: "Re-run failed matrix job",
        rationale: "Timeout looks environmental; rerun before deeper investigation.",
      },
    ],
    evidence: [
      { id: "ev_1", label: "CI log excerpt", href: "/en/workspace/code/ci/log.txt" },
      { id: "ev_2", label: "Related issue #7", href: "/en/workspace/issues/7" },
    ],
    citations: [
      {
        id: "cit_1",
        kind: "issue",
        label: "Issue #7",
        url: "/en/workspace/issues/7",
      },
      {
        id: "cit_2",
        kind: "file",
        label: "playwright.config.ts",
        url: "/en/workspace/code/playwright.config.ts",
      },
    ],
  },
};

async function dispatchSessionsGet(context: MegaDispatchContext): Promise<unknown> {
  const { segments } = context;
  if (segments[0] === "sessions" && segments.length === 2) {
    const id = segmentText(segments[1]);
    const fixture = FIXTURES[id];
    if (!fixture) throw new MegaNotFoundError("Session", id);
    return fixture;
  }
  return invalidRoute(segments);
}

registerMegaRoute({
  match: (method, segments) => method === "GET" && segments[0] === "sessions",
  handle: dispatchSessionsGet,
});
