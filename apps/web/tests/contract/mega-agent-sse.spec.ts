/**
 * WA-06 agent SSE BFF contract tests (ask / regenerate streaming).
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../../app/api/mega/[...segments]/route";
import { getAuth } from "../../lib/auth";
import type { AgentStreamEvent } from "../../lib/adapter/handlers/agent-stream";
import {
  maybeHandleAgentStreamPost,
  resetAgentStreamLlmClientForTests,
  setAgentStreamLlmClientForTests,
} from "../../lib/adapter/handlers/agent-stream";
import { getAgentDomain, resetEngineDomainsForTests } from "../../lib/engine";

const fixture = ownedContractFixture();
afterAll(() => fixture.close(), 120_000);

function megaUrl(path: string): string {
  return `http://127.0.0.1:3000/api/mega${path}`;
}

function canonicalOrigin(): string {
  return new URL(process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").origin;
}

function authedRequest(path: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(megaUrl(path), {
    ...init,
    headers: {
      Cookie: cookie,
      Origin: canonicalOrigin(),
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function postAgentStream(
  path: string,
  segments: readonly string[],
  cookie: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await maybeHandleAgentStreamPost(
    authedRequest(path, cookie, {
      method: "POST",
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    }),
    segments,
    payload,
  );
  if (!response) {
    throw new Error(`Expected SSE response for /api/mega/${segments.join("/")}`);
  }
  return response;
}

async function parseSseEvents(response: Response): Promise<AgentStreamEvent[]> {
  const text = await response.text();
  const events: AgentStreamEvent[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    events.push(JSON.parse(payload) as AgentStreamEvent);
  }
  return events;
}

function stubLlm(chunks: readonly string[]) {
  return {
    async *stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe(
  "WA-06 mega agent SSE BFF contract",
  () => {
    let sessionCookieHeader: string;
    let actorUserId: string;
    let threadId: string;

    beforeAll(async () => {
      await fixture.start();

      sessionCookieHeader = await fixture.mint();
      const session = await getAuth().api.getSession({
        headers: new Headers({ Cookie: sessionCookieHeader }),
      });
      actorUserId = session?.user?.id ?? "";
      expect(actorUserId).not.toBe("");
    }, 60_000);

    beforeEach(async () => {
      resetEngineDomainsForTests();
      resetAgentStreamLlmClientForTests();
      const { store } = getAgentDomain();
      const thread = await store.createThread({ title: "SSE contract thread" }, actorUserId);
      threadId = thread.id;
    });

    afterEach(() => {
      resetAgentStreamLlmClientForTests();
    });

    it("returns 404 on /api/mega/agent/:threadId/ask since the public agent surface is retired", async () => {
      const response = await POST(
        authedRequest(`/agent/${threadId}/ask`, sessionCookieHeader, {
          method: "POST",
          body: JSON.stringify({ message: "Retired route" }),
        }),
        { params: Promise.resolve({ segments: ["agent", threadId, "ask"] }) },
      );

      expect(response.status).toBe(404);
    });

    it("streams start → delta → done with stub LLM", async () => {
      setAgentStreamLlmClientForTests(stubLlm(["Hello", " world"]));

      const response = await postAgentStream(
        `/agent/${threadId}/ask`,
        ["agent", threadId, "ask"],
        sessionCookieHeader,
        { message: "What is megaui?" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const events = await parseSseEvents(response);
      expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "done"]);

      const start = events[0];
      expect(start?.type).toBe("start");
      if (start?.type === "start") {
        expect(start.question?.role).toBe("user");
        expect(start.answer.role).toBe("assistant");
      }

      const deltas = events.filter((event) => event.type === "delta");
      expect(deltas).toHaveLength(2);
      if (deltas[0]?.type === "delta" && deltas[1]?.type === "delta") {
        expect(deltas[0].chunkIndex).toBe(0);
        expect(deltas[1].chunkIndex).toBe(1);
        expect(deltas[0].text + deltas[1].text).toBe("Hello world");
      }

      const done = events.at(-1);
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.answer.body).toBe("Hello world");
        expect(done.thread.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
      }
    });

    it("returns llm_disabled on HTTP 200 when LLM is not configured", async () => {
      setAgentStreamLlmClientForTests(null);

      const response = await postAgentStream(
        `/agent/${threadId}/ask`,
        ["agent", threadId, "ask"],
        sessionCookieHeader,
        { message: "Ping without LLM" },
      );

      expect(response.status).toBe(200);
      const events = await parseSseEvents(response);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("llm_disabled");

      const { store } = getAgentDomain();
      const thread = await store.getThread(threadId);
      const assistants = thread.messages.filter((message) => message.role === "assistant");
      expect(assistants).toHaveLength(0);
    });

    it("regenerate replaces the trailing assistant without duplicating rows", async () => {
      setAgentStreamLlmClientForTests(stubLlm(["First", " answer"]));

      const askResponse = await postAgentStream(
        `/agent/${threadId}/ask`,
        ["agent", threadId, "ask"],
        sessionCookieHeader,
        { message: "Seed turn" },
      );
      await parseSseEvents(askResponse);

      setAgentStreamLlmClientForTests(stubLlm(["Re", "generated"]));

      const regenResponse = await postAgentStream(
        `/agent/${threadId}/regenerate`,
        ["agent", threadId, "regenerate"],
        sessionCookieHeader,
        {},
      );
      const regenEvents = await parseSseEvents(regenResponse);
      expect(regenEvents.at(-1)?.type).toBe("done");

      setAgentStreamLlmClientForTests(stubLlm(["Again"]));

      const secondRegen = await postAgentStream(
        `/agent/${threadId}/regenerate`,
        ["agent", threadId, "regenerate"],
        sessionCookieHeader,
        {},
      );
      await parseSseEvents(secondRegen);

      const { store } = getAgentDomain();
      const afterRegen = await store.getThread(threadId);
      const assistants = afterRegen.messages.filter((message) => message.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.body).toBe("Again");
    });

    it("releases the streaming placeholder when the client aborts", async () => {
      setAgentStreamLlmClientForTests({
        async *stream(_messages, signal) {
          yield "partial";
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (signal?.aborted) return;
          yield " tail";
        },
      });

      const controller = new AbortController();
      const responsePromise = postAgentStream(
        `/agent/${threadId}/ask`,
        ["agent", threadId, "ask"],
        sessionCookieHeader,
        { message: "Abort me" },
        controller.signal,
      );

      const response = await responsePromise;
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const { store } = getAgentDomain();
      const thread = await store.getThread(threadId);
      const assistants = thread.messages.filter((message) => message.role === "assistant");
      expect(assistants).toHaveLength(0);
    });
    it("preserves the prior assistant reply when regenerate is aborted", async () => {
      setAgentStreamLlmClientForTests(stubLlm(["Keep", " me"]));

      const askResponse = await postAgentStream(
        `/agent/${threadId}/ask`,
        ["agent", threadId, "ask"],
        sessionCookieHeader,
        { message: "Original" },
      );
      await parseSseEvents(askResponse);

      setAgentStreamLlmClientForTests({
        async *stream(_messages, signal) {
          yield "partial";
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (signal?.aborted) return;
          yield " regen";
        },
      });

      const controller = new AbortController();
      const response = await postAgentStream(
        `/agent/${threadId}/regenerate`,
        ["agent", threadId, "regenerate"],
        sessionCookieHeader,
        {},
        controller.signal,
      );

      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const { store } = getAgentDomain();
      const thread = await store.getThread(threadId);
      const assistants = thread.messages.filter((message) => message.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.body).toBe("Keep me");
    });
  },
);
