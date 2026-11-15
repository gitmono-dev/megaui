import { expect, test, type Page } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

const AUTHOR_MSG = {
  id: "am_user_1",
  role: "user" as const,
  segments: [{ type: "text", text: "Why is CI flaky?" }],
  citations: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ASSISTANT_MSG = {
  id: "am_asst_1",
  role: "assistant" as const,
  segments: [{ type: "text", text: "Likely a flake in the matrix job." }],
  citations: [
    {
      id: "cit_1",
      kind: "issue",
      label: "Issue #7",
      url: "/en/workspace/issues/7",
    },
  ],
  createdAt: "2026-01-01T00:00:01.000Z",
};

const THREAD = {
  id: "agent_thread_1",
  title: "CI flake",
  messages: [AUTHOR_MSG, ASSISTANT_MSG],
  updatedAt: "2026-01-01T00:00:01.000Z",
};

async function stubRail(page: Page): Promise<void> {
  await page.route("**/api/mega/channels**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route("**/api/mega/notifications/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { count: 0 } }),
    });
  });
}

function encodeSse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function stubAgentApis(
  page: Page,
  options?: { llmDisabled?: boolean; emptyList?: boolean },
): Promise<void> {
  await stubRail(page);
  let thread = { ...THREAD, messages: [...THREAD.messages] };

  await page.route("**/api/mega/sessions/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    if (id !== "sess_demo") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEGA_NOT_FOUND", messageKey: "errors.mega.notFound", message: "missing" },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "sess_demo",
          title: "Investigate flaky CI",
          status: "completed",
          threadRef: "refs/ai/sess_demo",
          usage: { inputTokens: 1200, outputTokens: 480, totalTokens: 1680, latencyMs: 2400 },
          decisions: [{ id: "dec_1", label: "Re-run failed matrix job", rationale: "Timeout." }],
          evidence: [{ id: "ev_2", label: "Related issue #7", href: "/en/workspace/issues/7" }],
          citations: [
            { id: "cit_1", kind: "issue", label: "Issue #7", url: "/en/workspace/issues/7" },
          ],
        },
      }),
    });
  });

  await page.route("**/api/mega/agent**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const path = new URL(url).pathname.replace(/^\/api\/mega\/?/, "");

    if (path === "agent" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: options?.emptyList
            ? { items: [], total: 0, offset: 0, limit: 20 }
            : { items: [thread], total: 1, offset: 0, limit: 20 },
        }),
      });
      return;
    }

    if (path === "agent" && method === "POST") {
      thread = { ...THREAD, id: "agent_thread_new", title: "New conversation", messages: [] };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: thread }),
      });
      return;
    }

    if (path === `agent/${thread.id}` && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: thread }),
      });
      return;
    }

    if (path.endsWith("/ask") && method === "POST") {
      if (options?.llmDisabled) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream; charset=utf-8",
          body: encodeSse({ type: "llm_disabled", reason: "LLM_NOT_CONFIGURED", thread }),
        });
        return;
      }

      const body = route.request().postDataJSON() as { message: string };
      const question = {
        id: `am_user_${Date.now()}`,
        role: "user" as const,
        segments: [{ type: "text", text: body.message }],
        citations: [],
        createdAt: new Date().toISOString(),
      };
      const answer = {
        id: `am_asst_${Date.now()}`,
        role: "assistant" as const,
        segments: [{ type: "text", text: "" }],
        citations: [
          {
            id: "cit_stream",
            kind: "file",
            label: "playwright.config.ts",
            url: "/en/workspace/code/playwright.config.ts",
          },
        ],
        createdAt: new Date().toISOString(),
      };
      const finalAnswer = {
        ...answer,
        segments: [{ type: "text", text: "Streamed answer about CI." }],
      };
      thread = {
        ...thread,
        messages: [...thread.messages, question, finalAnswer],
        updatedAt: new Date().toISOString(),
      };

      const stream =
        encodeSse({ type: "start", question, answer, thread }) +
        encodeSse({ type: "delta", text: "Streamed ", answerId: answer.id, chunkIndex: 0 }) +
        encodeSse({ type: "delta", text: "answer about CI.", answerId: answer.id, chunkIndex: 1 }) +
        encodeSse({ type: "done", answer: finalAnswer, thread });

      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: stream,
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: thread }),
    });
  });
}

test.describe("workspace agent (WA-15)", () => {
  test("ask streams then refreshes thread", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubAgentApis(page);

    await page.goto("/en/workspace/agent/agent_thread_1");
    await expect(page.locator('[data-mega-agent="title"]')).toContainText("CI flake");
    await page.locator('[data-mega-agent="composer-input"]').fill("What timed out?");
    await page.locator('[data-mega-agent="composer-send"]').click();
    await expect(page.locator('[data-message-role="assistant"]').filter({ hasText: "Streamed answer about CI." })).toBeVisible({
      timeout: 10_000,
    });

    await context.close();
  });

  test("llm_disabled guide state", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubAgentApis(page, { llmDisabled: true });

    await page.goto("/en/workspace/agent/agent_thread_1");
    await page.locator('[data-mega-agent="composer-input"]').fill("Hello?");
    await page.locator('[data-mega-agent="composer-send"]').click();
    await expect(page.locator('[data-mega-agent="llm-disabled"]')).toBeVisible();

    await context.close();
  });

  test("session usage and citation navigation", async ({ browser }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({ baseURL: e2eBaseURL() });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await stubAgentApis(page);

    await page.goto("/en/workspace/sessions/sess_demo");
    await expect(page.locator('[data-mega-session="title"]')).toContainText("Investigate flaky CI");
    await expect(page.locator('[data-slot="message-usage"]')).toContainText("1680");
    await page.locator('[data-slot="message-citations"] a').first().click();
    await expect(page).toHaveURL(/\/en\/workspace\/issues\/7/);

    await context.close();
  });
});
