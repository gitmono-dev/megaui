import { describe, expect, it } from "vitest";
import { MegaInternalError, isMegaError } from "../../errors";
import { createAgentLlmClient, resolveAgentLlmConfig } from "./llm";
import type { AgentLlmMessage } from "./types";

const CONFIG = { baseURL: "https://llm.example.test/v1", apiKey: "test-key", model: "test-model" };
const MESSAGES: AgentLlmMessage[] = [
  { role: "system", text: "You are a test agent." },
  { role: "user", text: "Ping?" },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatCompletionBody(text: string, finishReason = "stop") {
  return { choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason }] };
}

function errorBody(message: string) {
  return { error: { message } };
}

describe("resolveAgentLlmConfig (ADR-ARCH-06)", () => {
  it("requires all three of AI_BASE_URL / AI_API_KEY / AI_MODEL", () => {
    expect(resolveAgentLlmConfig({})).toBeNull();
    expect(resolveAgentLlmConfig({ AI_BASE_URL: "https://x" })).toBeNull();
    expect(resolveAgentLlmConfig({ AI_BASE_URL: "https://x", AI_API_KEY: "k" })).toBeNull();
    expect(
      resolveAgentLlmConfig({ AI_BASE_URL: "https://x", AI_API_KEY: "k", AI_MODEL: "m" }),
    ).toEqual({ baseURL: "https://x", apiKey: "k", model: "m" });
  });

  it("trims and treats blank strings as unset", () => {
    expect(
      resolveAgentLlmConfig({ AI_BASE_URL: "  ", AI_API_KEY: "k", AI_MODEL: "m" }),
    ).toBeNull();
  });
});

describe("createAgentLlmClient (EG-12 AC3: stubbed success / timeout / 5xx bounded retry)", () => {
  it("returns the completion text and finish reason on a successful call", async () => {
    let calls = 0;
    const client = createAgentLlmClient(CONFIG, {
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, chatCompletionBody("pong"));
      },
    });

    const result = await client.complete(MESSAGES);
    expect(result).toEqual({ text: "pong", finishReason: "stop" });
    expect(calls).toBe(1);
  });

  it("retries a 5xx response with bounded attempts and eventually succeeds", async () => {
    let calls = 0;
    const client = createAgentLlmClient(CONFIG, {
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        calls += 1;
        if (calls < 3) return jsonResponse(503, errorBody("Service Unavailable"));
        return jsonResponse(200, chatCompletionBody("recovered"));
      },
    });

    const result = await client.complete(MESSAGES);
    expect(result.text).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("exhausts the bounded retry budget on a persistent 5xx and fails as a MegaError (ER-10)", async () => {
    let calls = 0;
    const client = createAgentLlmClient(CONFIG, {
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        calls += 1;
        return jsonResponse(500, errorBody("Internal Server Error"));
      },
    });

    await expect(client.complete(MESSAGES)).rejects.toThrow(MegaInternalError);
    expect(calls).toBe(3);
  });

  it("does not retry a deterministic 4xx response (ER-10: fails on the first attempt)", async () => {
    let calls = 0;
    const client = createAgentLlmClient(CONFIG, {
      retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        calls += 1;
        return jsonResponse(400, errorBody("Bad Request"));
      },
    });

    try {
      await client.complete(MESSAGES);
      expect.unreachable("complete should have thrown");
    } catch (error) {
      expect(isMegaError(error)).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it("retries a timeout/abort failure and eventually succeeds", async () => {
    let calls = 0;
    const client = createAgentLlmClient(CONFIG, {
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        calls += 1;
        if (calls < 2) throw new DOMException("The operation timed out.", "TimeoutError");
        return jsonResponse(200, chatCompletionBody("back online"));
      },
    });

    const result = await client.complete(MESSAGES);
    expect(result.text).toBe("back online");
    expect(calls).toBe(2);
  });

  it("gives up after exhausting retries on a persistent timeout", async () => {
    let calls = 0;
    const client = createAgentLlmClient(CONFIG, {
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        calls += 1;
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    await expect(client.complete(MESSAGES)).rejects.toThrow(MegaInternalError);
    expect(calls).toBe(2);
  });

  it("never leaks the request body/messages into the thrown error message (ER-11)", async () => {
    const secretLikeText = "sk-super-secret-should-not-leak";
    const client = createAgentLlmClient(CONFIG, {
      retry: { maxAttempts: 1 },
      fetch: async () => jsonResponse(500, errorBody("Internal Server Error")),
    });

    try {
      await client.complete([{ role: "user", text: secretLikeText }]);
      expect.unreachable("complete should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(secretLikeText);
      expect((error as Error).message).not.toContain(CONFIG.apiKey);
    }
  });
});
