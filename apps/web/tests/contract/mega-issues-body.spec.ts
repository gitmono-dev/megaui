/**
 * IB-02 issues body GET/POST BFF contract tests.
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import { createDatabaseClient } from "@megaui/database";
import { MEGA_ERROR_CODES, createIssuesService } from "@megaui/engine";
import { USERS } from "@megaui/engine/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "../../app/api/mega/[...segments]/route";
import { assertMegaFailureEnvelope, assertMegaSuccessEnvelope } from "../../lib/adapter/envelope";

const fixture = ownedContractFixture();
afterAll(() => fixture.close(), 120_000);

function megaUrl(path: string): string {
  return `http://127.0.0.1:3000/api/mega${path}`;
}

function authedRequest(path: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(megaUrl(path), {
    ...init,
    headers: {
      Cookie: cookie,
      ...(init.headers ?? {}),
    },
  });
}

describe("IB-02 mega issues body BFF contract", () => {
  let sessionCookieHeader: string;

  beforeAll(async () => {
    await fixture.start();

    sessionCookieHeader = await fixture.mint();
  }, 120_000);

  async function createIssue(title: string, body?: string): Promise<number> {
    const response = await POST(
      authedRequest("/issues", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          packageId: "pkg_engine",
          priority: "P2",
          ...(body ? { body } : {}),
        }),
      }),
      { params: Promise.resolve({ segments: ["issues"] }) },
    );
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    assertMegaSuccessEnvelope(payload);
    const record = payload.data as { number: number };
    expect(typeof record.number).toBe("number");
    return record.number;
  }

  it("returns the engine { body } payload in the success envelope (new)", async () => {
    const number = await createIssue(`ib-02-get-empty-${Date.now()}`);
    const emptyResponse = await GET(authedRequest(`/issues/${number}/body`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["issues", String(number), "body"] }),
    });
    expect(emptyResponse.status).toBe(200);
    const emptyBody: unknown = await emptyResponse.json();
    assertMegaSuccessEnvelope(emptyBody);
    expect(emptyBody.data).toEqual({ body: "" });
  });

  it("returns { body: saved text } when POST { body } is non-empty (new)", async () => {
    const number = await createIssue(`ib-02-post-${Date.now()}`);
    const response = await POST(
      authedRequest(`/issues/${number}/body`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "  Saved via BFF  " }),
      }),
      { params: Promise.resolve({ segments: ["issues", String(number), "body"] }) },
    );
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    assertMegaSuccessEnvelope(payload);
    expect(payload.data).toEqual({ body: "Saved via BFF" });

    const fetched = await GET(authedRequest(`/issues/${number}/body`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["issues", String(number), "body"] }),
    });
    expect(fetched.status).toBe(200);
    const fetchedBody: unknown = await fetched.json();
    assertMegaSuccessEnvelope(fetchedBody);
    expect(fetchedBody.data).toEqual({ body: "Saved via BFF" });
  });

  it("returns 400 when POST body is missing or blank (new)", async () => {
    const number = await createIssue(`ib-02-blank-${Date.now()}`);

    const missing = await POST(
      authedRequest(`/issues/${number}/body`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ segments: ["issues", String(number), "body"] }) },
    );
    expect(missing.status).toBe(400);
    const missingBody: unknown = await missing.json();
    assertMegaFailureEnvelope(missingBody);
    expect(missingBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
    expect(missingBody.error.messageKey).toBe("errors.mega.badRequest");

    const blank = await POST(
      authedRequest(`/issues/${number}/body`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "   " }),
      }),
      { params: Promise.resolve({ segments: ["issues", String(number), "body"] }) },
    );
    expect(blank.status).toBe(400);
    const blankBody: unknown = await blank.json();
    assertMegaFailureEnvelope(blankBody);
    expect(blankBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
  });

  it("maps GET/POST failures through the same DIR-03 envelope as getIssue (new)", async () => {
    const client = createDatabaseClient({ connectionString: process.env.DATABASE_URL! });
    try {
      const issues = createIssuesService(client.db);
      const foreign = await issues.createIssue(
        { title: `ib-02-foreign-${Date.now()}`, packageId: "pkg_engine", priority: "P2" },
        USERS.tianjing.id,
      );

      const forbiddenPost = await POST(
        authedRequest(`/issues/${foreign.number}/body`, sessionCookieHeader, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: "nope" }),
        }),
        { params: Promise.resolve({ segments: ["issues", String(foreign.number), "body"] }) },
      );
      expect(forbiddenPost.status).toBe(403);
      const forbiddenPostBody: unknown = await forbiddenPost.json();
      assertMegaFailureEnvelope(forbiddenPostBody);
      expect(forbiddenPostBody.error.code).toBe(MEGA_ERROR_CODES.FORBIDDEN);
      expect(forbiddenPostBody.error.messageKey).toBe("errors.mega.forbidden");
    } finally {
      await client.close();
    }

    const missingGet = await GET(authedRequest("/issues/999999/body", sessionCookieHeader), {
      params: Promise.resolve({ segments: ["issues", "999999", "body"] }),
    });
    const missingIssue = await GET(authedRequest("/issues/999999", sessionCookieHeader), {
      params: Promise.resolve({ segments: ["issues", "999999"] }),
    });
    expect(missingGet.status).toBe(missingIssue.status);
    expect(missingGet.status).toBe(404);
    const missingGetBody: unknown = await missingGet.json();
    const missingIssueBody: unknown = await missingIssue.json();
    assertMegaFailureEnvelope(missingGetBody);
    assertMegaFailureEnvelope(missingIssueBody);
    expect(missingGetBody.error.code).toBe(missingIssueBody.error.code);
    expect(missingGetBody.error.messageKey).toBe(missingIssueBody.error.messageKey);
    expect(missingGetBody.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);

    const missingPost = await POST(
      authedRequest("/issues/999999/body", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "nope" }),
      }),
      { params: Promise.resolve({ segments: ["issues", "999999", "body"] }) },
    );
    expect(missingPost.status).toBe(404);
    const missingPostBody: unknown = await missingPost.json();
    assertMegaFailureEnvelope(missingPostBody);
    expect(missingPostBody.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
  });
});
