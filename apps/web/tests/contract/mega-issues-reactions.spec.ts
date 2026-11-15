/**
 * RX-02 issues / issue-comment reaction BFF contract tests.
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import { MEGA_ERROR_CODES } from "@megaui/engine";
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

function unauthedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(megaUrl(path), init);
}

describe("RX-02 mega issue reaction BFF contract", () => {
  let sessionCookieHeader: string;

  beforeAll(async () => {
    await fixture.start();

    sessionCookieHeader = await fixture.mint();
  }, 120_000);

  async function createIssue(title: string): Promise<number> {
    const response = await POST(
      authedRequest("/issues", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, packageId: "pkg_engine", priority: "P2" }),
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

  async function addComment(issueNumber: number, body: string): Promise<string> {
    const response = await POST(
      authedRequest(`/issues/${issueNumber}/comments`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }),
      { params: Promise.resolve({ segments: ["issues", String(issueNumber), "comments"] }) },
    );
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    assertMegaSuccessEnvelope(payload);
    const record = payload.data as { id: string };
    expect(typeof record.id).toBe("string");
    return record.id;
  }

  it("returns Issue from POST issues/:n/reactions and matches GET getIssue (new)", async () => {
    const number = await createIssue(`rx-02-issue-${Date.now()}`);
    const response = await POST(
      authedRequest(`/issues/${number}/reactions`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      }),
      { params: Promise.resolve({ segments: ["issues", String(number), "reactions"] }) },
    );
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    assertMegaSuccessEnvelope(payload);
    const issue = payload.data as { reactions: Array<{ emoji: string; count: number; reactedByMe: boolean }> };
    expect(issue.reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

    const fetched = await GET(authedRequest(`/issues/${number}`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["issues", String(number)] }),
    });
    expect(fetched.status).toBe(200);
    const fetchedBody: unknown = await fetched.json();
    assertMegaSuccessEnvelope(fetchedBody);
    expect((fetchedBody.data as { reactions: unknown }).reactions).toEqual(issue.reactions);
  });

  it("returns IssueComment from POST issue-comments/:id/reactions and matches GET comments (new)", async () => {
    const number = await createIssue(`rx-02-comment-${Date.now()}`);
    const commentId = await addComment(number, "react to me");
    const response = await POST(
      authedRequest(`/issue-comments/${commentId}/reactions`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "🎉" }),
      }),
      { params: Promise.resolve({ segments: ["issue-comments", commentId, "reactions"] }) },
    );
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    assertMegaSuccessEnvelope(payload);
    const comment = payload.data as {
      id: string;
      reactions: Array<{ emoji: string; count: number; reactedByMe: boolean }>;
    };
    expect(comment.id).toBe(commentId);
    expect(comment.reactions).toEqual([{ emoji: "🎉", count: 1, reactedByMe: true }]);

    const listed = await GET(authedRequest(`/issues/${number}/comments`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["issues", String(number), "comments"] }),
    });
    expect(listed.status).toBe(200);
    const listedBody: unknown = await listed.json();
    assertMegaSuccessEnvelope(listedBody);
    const comments = listedBody.data as Array<{ id: string; reactions: unknown }>;
    expect(comments.find((entry) => entry.id === commentId)?.reactions).toEqual(comment.reactions);
  });

  it("returns 400 when POST emoji is missing or blank (new)", async () => {
    const number = await createIssue(`rx-02-blank-${Date.now()}`);
    const commentId = await addComment(number, "blank emoji");

    const missing = await POST(
      authedRequest(`/issues/${number}/reactions`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ segments: ["issues", String(number), "reactions"] }) },
    );
    expect(missing.status).toBe(400);
    const missingBody: unknown = await missing.json();
    assertMegaFailureEnvelope(missingBody);
    expect(missingBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);

    const blank = await POST(
      authedRequest(`/issue-comments/${commentId}/reactions`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "   " }),
      }),
      { params: Promise.resolve({ segments: ["issue-comments", commentId, "reactions"] }) },
    );
    expect(blank.status).toBe(400);
    const blankBody: unknown = await blank.json();
    assertMegaFailureEnvelope(blankBody);
    expect(blankBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
  });

  it("maps POST failures through the DIR-03 envelope (new)", async () => {
    const unauthed = await POST(
      unauthedRequest("/issues/1/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      }),
      { params: Promise.resolve({ segments: ["issues", "1", "reactions"] }) },
    );
    expect(unauthed.status).toBe(401);
    const unauthedBody: unknown = await unauthed.json();
    assertMegaFailureEnvelope(unauthedBody);
    expect(unauthedBody.error.code).toBe(MEGA_ERROR_CODES.UNAUTHORIZED);

    const missingIssue = await POST(
      authedRequest("/issues/999999/reactions", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      }),
      { params: Promise.resolve({ segments: ["issues", "999999", "reactions"] }) },
    );
    expect(missingIssue.status).toBe(404);
    const missingIssueBody: unknown = await missingIssue.json();
    assertMegaFailureEnvelope(missingIssueBody);
    expect(missingIssueBody.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
    expect(missingIssueBody.error.messageKey).toBe("errors.mega.notFound");

    const missingComment = await POST(
      authedRequest("/issue-comments/ic_missing/reactions", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      }),
      { params: Promise.resolve({ segments: ["issue-comments", "ic_missing", "reactions"] }) },
    );
    expect(missingComment.status).toBe(404);
    const missingCommentBody: unknown = await missingComment.json();
    assertMegaFailureEnvelope(missingCommentBody);
    expect(missingCommentBody.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
  });
});
