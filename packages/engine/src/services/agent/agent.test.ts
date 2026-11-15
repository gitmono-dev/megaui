import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "@megaui/database";
import type { AgentThread } from "@megaui/core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MegaBadRequestError, MegaConflictError, MegaNotFoundError, MegaUnauthorizedError } from "../../errors";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { createAgentService } from "./agent";
import { createAgentThreadsStore } from "./store";
import type { AgentLlmClient, AgentLlmMessage } from "./types";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error("[@megaui/engine] agent/agent.test.ts: DATABASE_URL is required in CI.");
  }
  console.warn("[@megaui/engine] agent/agent.test.ts: DATABASE_URL is unset — skipping PG agent suite.");
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** A scripted `AgentLlmClient` stub — no network, no `@ai-sdk/openai-compatible` involved (that call surface is covered by `llm.test.ts`). */
function fakeLlmClient(reply: (messages: readonly AgentLlmMessage[], call: number) => string): AgentLlmClient & { calls: AgentLlmMessage[][] } {
  const calls: AgentLlmMessage[][] = [];
  return {
    calls,
    async complete(messages) {
      calls.push([...messages]);
      return { text: reply(messages, calls.length), finishReason: "stop" };
    },
  };
}

/** A stub that throws on `complete` (simulates `./llm.ts` exhausting its bounded retry and rethrowing). */
function throwingLlmClient(message = "Agent LLM request failed after 5 attempt(s): status=503"): AgentLlmClient & { calls: AgentLlmMessage[][] } {
  const calls: AgentLlmMessage[][] = [];
  return {
    calls,
    async complete(messages) {
      calls.push([...messages]);
      throw new Error(message);
    },
  };
}

describe.skipIf(!adminDatabaseUrl)("agent domain (EG-12, throwaway PG)", () => {
  const testDbName = `megaui_test_agent_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: import("pg").Pool;
  let connectionString: string;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
    const migratePool = new Pool({ connectionString });
    const client = createDatabaseClient({ connectionString });
    try {
      await migrate((await import("drizzle-orm/node-postgres")).drizzle(migratePool), { migrationsFolder });
      await seedMegaDatabase(client.db);
    } finally {
      await client.close();
      await migratePool.end();
    }
  });

  afterAll(async () => {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  });

  describe("createAgentThreadsStore: threads/messages CRUD (AC1)", () => {
    it("creates a thread and round-trips it empty through getThread", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const created = await store.createThread({ title: "  Investigate flaky CI  " }, USERS.tianjing.id);
        expect(created.title).toBe("Investigate flaky CI");
        expect(created.messages).toEqual([]);

        const fetched = await store.getThread(created.id);
        expect(fetched).toEqual(created);
      } finally {
        await client.close();
      }
    });

    it("rejects createThread for an unauthenticated actor and a blank title", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        await expect(store.createThread({ title: "x" }, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(store.createThread({ title: "  " }, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaBadRequestError);
      } finally {
        await client.close();
      }
    });

    it("lists threads newest-first with pagination", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const first = await store.createThread({ title: "List thread A" }, USERS.tianjing.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await store.createThread({ title: "List thread B" }, USERS.tianjing.id);

        const page = await store.listThreads({ pagination: { limit: 1 } });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.id).toBe(second.id);
        expect(page.total).toBeGreaterThanOrEqual(2);

        const nextPage = await store.listThreads({ pagination: { limit: 1, offset: 1 } });
        expect(nextPage.items[0]?.id).toBe(first.id);
      } finally {
        await client.close();
      }
    });

    it("appends a user message and bumps the thread's updatedAt", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const thread = await store.createThread({ title: "Message ordering" }, USERS.tianjing.id);
        const message = await store.appendUserMessage(thread.id, "  What broke the build?  ", USERS.tianjing.id);
        expect(message.role).toBe("user");
        expect(message.body).toBe("What broke the build?");
        expect(message.segments).toEqual([{ type: "text", text: "What broke the build?" }]);

        const reloaded = await store.getThread(thread.id);
        expect(reloaded.messages.map((m) => m.id)).toEqual([message.id]);
        expect(new Date(reloaded.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(thread.updatedAt).getTime());
      } finally {
        await client.close();
      }
    });

    it("rejects appendUserMessage for an unauthenticated actor and an empty body", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const thread = await store.createThread({ title: "Guard rails" }, USERS.tianjing.id);
        await expect(store.appendUserMessage(thread.id, "hi", null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(store.appendUserMessage(thread.id, "   ", USERS.tianjing.id)).rejects.toBeInstanceOf(MegaBadRequestError);
      } finally {
        await client.close();
      }
    });

    it("appendUserMessage on a missing thread fails closed with MegaNotFoundError", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        await expect(store.appendUserMessage("agent_thread_does_not_exist", "hi", USERS.tianjing.id)).rejects.toBeInstanceOf(
          MegaNotFoundError,
        );
      } finally {
        await client.close();
      }
    });

    it("card AC1: re-applying an already-seen chunkIndex is a no-op (idempotent incremental persistence)", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const thread = await store.createThread({ title: "Chunk idempotency" }, USERS.tianjing.id);
        const started = await store.startAssistantMessage(thread.id);
        expect(started.body).toBe("");

        const afterFirst = await store.appendAssistantChunk(thread.id, started.id, 0, "Hello");
        expect(afterFirst.body).toBe("Hello");

        // Same chunkIndex delivered twice (e.g. an SSE resume replay) must not double-append.
        const afterDuplicate = await store.appendAssistantChunk(thread.id, started.id, 0, "Hello");
        expect(afterDuplicate.body).toBe("Hello");

        const afterSecondChunk = await store.appendAssistantChunk(thread.id, started.id, 1, " world");
        expect(afterSecondChunk.body).toBe("Hello world");

        // Replaying chunk 0 again after chunk 1 landed still must not re-append or reorder text.
        const afterLateReplay = await store.appendAssistantChunk(thread.id, started.id, 0, "Hello");
        expect(afterLateReplay.body).toBe("Hello world");
      } finally {
        await client.close();
      }
    });

    it("rejects chunk append / complete on a non-assistant message", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const thread = await store.createThread({ title: "Role guard" }, USERS.tianjing.id);
        const userMessage = await store.appendUserMessage(thread.id, "Hello", USERS.tianjing.id);
        await expect(store.appendAssistantChunk(thread.id, userMessage.id, 0, "nope")).rejects.toBeInstanceOf(
          MegaBadRequestError,
        );
        await expect(store.completeAssistantMessage(thread.id, userMessage.id, [])).rejects.toBeInstanceOf(
          MegaBadRequestError,
        );
      } finally {
        await client.close();
      }
    });

    it("completes an assistant message with citations and round-trips them", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const thread = await store.createThread({ title: "Citations" }, USERS.tianjing.id);
        const started = await store.startAssistantMessage(thread.id);
        await store.appendAssistantChunk(thread.id, started.id, 0, "See the linked issue.");
        const citation = { id: "cit_1", kind: "issue" as const, label: "#42", url: "/issues/42" };
        const completed = await store.completeAssistantMessage(thread.id, started.id, [citation]);
        expect(completed.citations).toEqual([citation]);

        const reloaded = await store.getThread(thread.id);
        expect(reloaded.messages[0]?.citations).toEqual([citation]);
      } finally {
        await client.close();
      }
    });

    it("dropTrailingAssistantMessage requires the last message to be an assistant reply", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const thread = await store.createThread({ title: "Regenerate guard" }, USERS.tianjing.id);
        await expect(store.dropTrailingAssistantMessage(thread.id)).rejects.toBeInstanceOf(MegaBadRequestError);

        await store.appendUserMessage(thread.id, "Question", USERS.tianjing.id);
        await expect(store.dropTrailingAssistantMessage(thread.id)).rejects.toBeInstanceOf(MegaBadRequestError);

        const started = await store.startAssistantMessage(thread.id);
        await store.completeAssistantMessage(thread.id, started.id, []);
        const trimmed = await store.dropTrailingAssistantMessage(thread.id);
        expect(trimmed.messages).toHaveLength(1);
        expect(trimmed.messages[0]?.role).toBe("user");
      } finally {
        await client.close();
      }
    });
  });

  describe("createAgentService.ask/regenerate orchestration", () => {
    it("ask() persists the user message and the LLM's reply, and regenerate() replaces the last reply", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const llm = fakeLlmClient((_messages, call) => (call === 1 ? "First answer" : "Second answer"));
        const service = createAgentService(client.db, llm);
        const thread = await service.createThread({ title: "Ask/regenerate" }, USERS.tianjing.id);

        const asked = await service.ask(thread.id, { message: "How do I deploy?" }, USERS.tianjing.id);
        expect(asked.status).toBe("answered");
        const afterAsk = (asked as { status: "answered"; thread: AgentThread }).thread;
        expect(afterAsk.messages.map((m) => [m.role, m.body])).toEqual([
          ["user", "How do I deploy?"],
          ["assistant", "First answer"],
        ]);

        // The prompt sent to the LLM carries the conversation history (system + user).
        expect(llm.calls[0]?.map((m) => m.role)).toEqual(["system", "user"]);
        expect(llm.calls[0]?.at(-1)?.text).toBe("How do I deploy?");

        const regenerated = await service.regenerate(thread.id, USERS.tianjing.id);
        expect(regenerated.status).toBe("answered");
        const afterRegenerate = (regenerated as { status: "answered"; thread: AgentThread }).thread;
        expect(afterRegenerate.messages.map((m) => [m.role, m.body])).toEqual([
          ["user", "How do I deploy?"],
          ["assistant", "Second answer"],
        ]);
        expect(llm.calls).toHaveLength(2);
      } finally {
        await client.close();
      }
    });

    it("regenerate() rejects when there is no assistant reply to regenerate", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const llm = fakeLlmClient(() => "unused");
        const service = createAgentService(client.db, llm);
        const thread = await service.createThread({ title: "Nothing to regenerate" }, USERS.tianjing.id);
        await expect(service.regenerate(thread.id, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaBadRequestError);
      } finally {
        await client.close();
      }
    });

    it("card AC2: ask()/regenerate() fail closed with an explicit llm_disabled state when no LLM is configured — never a fabricated answer", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const service = createAgentService(client.db, undefined);
        expect(service.isLlmConfigured()).toBe(false);
        const thread = await service.createThread({ title: "Degraded" }, USERS.tianjing.id);

        const asked = await service.ask(thread.id, { message: "Are you there?" }, USERS.tianjing.id);
        expect(asked.status).toBe("llm_disabled");
        if (asked.status !== "llm_disabled") throw new Error("unreachable");
        expect(asked.reason).toMatch(/AI_BASE_URL/);

        // The user's message is a real fact and is persisted; no assistant
        // message is fabricated in its place (GC-07).
        expect(asked.thread.messages.map((m) => m.role)).toEqual(["user"]);

        const regenerated = await service.regenerate(thread.id, USERS.tianjing.id);
        expect(regenerated.status).toBe("llm_disabled");
        // Disabled regenerate must not have dropped the (nonexistent) assistant reply.
        expect(regenerated.thread.messages.map((m) => m.role)).toEqual(["user"]);
      } finally {
        await client.close();
      }
    });

    it("ER-05 P1: ask() fails closed (not fabricated, not a permanent empty placeholder) when llm.complete throws", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const llm = throwingLlmClient();
        const service = createAgentService(client.db, llm);
        const thread = await service.createThread({ title: "LLM throws on ask" }, USERS.tianjing.id);

        const asked = await service.ask(thread.id, { message: "Are you there?" }, USERS.tianjing.id);
        expect(asked.status).toBe("failed");
        if (asked.status !== "failed") throw new Error("unreachable");
        expect(asked.reason).toMatch(/status=503/);

        // The user's message is a real fact and is persisted; no permanent
        // empty/streaming assistant placeholder is left behind for the
        // turn that failed.
        expect(asked.thread.messages.map((m) => [m.role, m.body])).toEqual([["user", "Are you there?"]]);

        const reloaded = await service.getThread(thread.id);
        expect(reloaded.messages).toHaveLength(1);
      } finally {
        await client.close();
      }
    });

    it("ER-05 P1: regenerate() fails closed and leaves the prior assistant reply untouched when llm.complete throws", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const workingLlm = fakeLlmClient(() => "The first, good answer");
        const service = createAgentService(client.db, workingLlm);
        const thread = await service.createThread({ title: "LLM throws on regenerate" }, USERS.tianjing.id);
        const asked = await service.ask(thread.id, { message: "How do I deploy?" }, USERS.tianjing.id);
        expect(asked.status).toBe("answered");

        // Swap in a throwing LLM for the regenerate call (createAgentService
        // captures `llm` in its closure, so a fresh service instance stands
        // in for "the LLM started failing between requests").
        const failingService = createAgentService(client.db, throwingLlmClient());
        const regenerated = await failingService.regenerate(thread.id, USERS.tianjing.id);
        expect(regenerated.status).toBe("failed");
        if (regenerated.status !== "failed") throw new Error("unreachable");
        expect(regenerated.reason).toMatch(/status=503/);

        // The prior answer must still be there — `dropTrailingAssistantMessage`
        // must never run before the replacement completion succeeds.
        expect(regenerated.thread.messages.map((m) => [m.role, m.body])).toEqual([
          ["user", "How do I deploy?"],
          ["assistant", "The first, good answer"],
        ]);
        const reloaded = await service.getThread(thread.id);
        expect(reloaded.messages.map((m) => [m.role, m.body])).toEqual([
          ["user", "How do I deploy?"],
          ["assistant", "The first, good answer"],
        ]);
      } finally {
        await client.close();
      }
    });

    it("EG-12 ER-05 P1: regenerate() fails closed with MegaConflictError when a concurrent ask() moves the trailing message before the replacement lands", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const store = createAgentThreadsStore(client.db);
        const workingLlm = fakeLlmClient(() => "The first, good answer");
        const service = createAgentService(client.db, workingLlm);
        const thread = await service.createThread({ title: "Regenerate race" }, USERS.tianjing.id);
        const asked = await service.ask(thread.id, { message: "How do I deploy?" }, USERS.tianjing.id);
        expect(asked.status).toBe("answered");

        // Simulates a concurrent ask() landing *while this regenerate's LLM
        // call is in flight* — appends a brand-new user + assistant turn
        // directly through the store before the stub returns its own
        // completion, so `regenerate()`'s captured trailing-message id is
        // stale by the time it tries to replace it.
        let concurrentAssistantId: string | undefined;
        const racyLlm: AgentLlmClient = {
          async complete() {
            await store.appendUserMessage(thread.id, "Concurrent question", USERS.tianjing.id);
            const started = await store.startAssistantMessage(thread.id);
            await store.appendAssistantChunk(thread.id, started.id, 0, "Concurrent answer");
            await store.completeAssistantMessage(thread.id, started.id, []);
            concurrentAssistantId = started.id;
            return { text: "Regenerated answer that must not land", finishReason: "stop" };
          },
        };
        const racyService = createAgentService(client.db, racyLlm);

        await expect(racyService.regenerate(thread.id, USERS.tianjing.id)).rejects.toBeInstanceOf(MegaConflictError);

        // The concurrent turn is untouched — nothing was dropped or clobbered.
        const reloaded = await service.getThread(thread.id);
        expect(reloaded.messages.map((m) => [m.role, m.body])).toEqual([
          ["user", "How do I deploy?"],
          ["assistant", "The first, good answer"],
          ["user", "Concurrent question"],
          ["assistant", "Concurrent answer"],
        ]);
        expect(reloaded.messages.at(-1)?.id).toBe(concurrentAssistantId);
      } finally {
        await client.close();
      }
    });

    it("rejects ask()/regenerate() for an unauthenticated actor", async () => {
      const client = createDatabaseClient({ connectionString });
      try {
        const service = createAgentService(client.db, undefined);
        const thread = await service.createThread({ title: "Auth guard" }, USERS.tianjing.id);
        await expect(service.ask(thread.id, { message: "hi" }, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
        await expect(service.regenerate(thread.id, null)).rejects.toBeInstanceOf(MegaUnauthorizedError);
      } finally {
        await client.close();
      }
    });
  });
});
