/**
 * DC-02 docs comments GET/POST BFF contract tests.
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import { MEGA_ERROR_CODES } from "@megaui/engine";
import { SAMPLE_DOC } from "@megaui/engine/testing";
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

describe("DC-02 mega docs comments BFF contract", () => {
  let sessionCookieHeader: string;

  beforeAll(async () => {
    await fixture.start();

    sessionCookieHeader = await fixture.mint();
  }, 120_000);

  async function createReadableDoc(): Promise<string> {
    const response = await POST(
      authedRequest("/docs", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `dc-02-comments-${Date.now()}` }),
      }),
      { params: Promise.resolve({ segments: ["docs"] }) },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    assertMegaSuccessEnvelope(body);
    const record = body.data as { id: string };
    expect(typeof record.id).toBe("string");
    return record.id;
  }

  it("returns the engine comment list in the success envelope (new)", async () => {
    const docId = await createReadableDoc();
    const emptyResponse = await GET(authedRequest(`/docs/${docId}/comments`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["docs", docId, "comments"] }),
    });
    expect(emptyResponse.status).toBe(200);
    const emptyBody: unknown = await emptyResponse.json();
    assertMegaSuccessEnvelope(emptyBody);
    expect(emptyBody.data).toEqual([]);

    const created = await POST(
      authedRequest(`/docs/${docId}/comments`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Persisted via BFF" }),
      }),
      { params: Promise.resolve({ segments: ["docs", docId, "comments"] }) },
    );
    expect(created.status).toBe(200);
    const createdBody: unknown = await created.json();
    assertMegaSuccessEnvelope(createdBody);
    const createdComment = createdBody.data as { id: string };

    const listed = await GET(authedRequest(`/docs/${docId}/comments`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["docs", docId, "comments"] }),
    });
    expect(listed.status).toBe(200);
    const listedBody: unknown = await listed.json();
    assertMegaSuccessEnvelope(listedBody);
    expect(listedBody.data).toEqual([
      expect.objectContaining({
        id: createdComment.id,
        docId,
        body: "Persisted via BFF",
        reactions: [],
      }),
    ]);
  });

  it("creates a DocComment when POST { body } is non-empty (new)", async () => {
    const docId = await createReadableDoc();
    const response = await POST(
      authedRequest(`/docs/${docId}/comments`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "  Hello comments  " }),
      }),
      { params: Promise.resolve({ segments: ["docs", docId, "comments"] }) },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    assertMegaSuccessEnvelope(body);
    expect(body.data).toEqual(
      expect.objectContaining({
        docId,
        body: "Hello comments",
        reactions: [],
      }),
    );
  });

  it("returns 400 when POST body is missing or blank (new)", async () => {
    const docId = await createReadableDoc();

    const missing = await POST(
      authedRequest(`/docs/${docId}/comments`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ segments: ["docs", docId, "comments"] }) },
    );
    expect(missing.status).toBe(400);
    const missingBody: unknown = await missing.json();
    assertMegaFailureEnvelope(missingBody);
    expect(missingBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
    expect(missingBody.error.messageKey).toBe("errors.mega.badRequest");

    const blank = await POST(
      authedRequest(`/docs/${docId}/comments`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "   " }),
      }),
      { params: Promise.resolve({ segments: ["docs", docId, "comments"] }) },
    );
    expect(blank.status).toBe(400);
    const blankBody: unknown = await blank.json();
    assertMegaFailureEnvelope(blankBody);
    expect(blankBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
  });

  it("returns workspace doc comments to another signed-in user (new)", async () => {
    const forbiddenGet = await GET(authedRequest(`/docs/${SAMPLE_DOC.id}/comments`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["docs", SAMPLE_DOC.id, "comments"] }),
    });
    const forbiddenDoc = await GET(authedRequest(`/docs/${SAMPLE_DOC.id}`, sessionCookieHeader), {
      params: Promise.resolve({ segments: ["docs", SAMPLE_DOC.id] }),
    });
    expect(forbiddenGet.status).toBe(forbiddenDoc.status);
    expect(forbiddenGet.status).toBe(200);
    const forbiddenGetBody: unknown = await forbiddenGet.json();
    const forbiddenDocBody: unknown = await forbiddenDoc.json();
    assertMegaSuccessEnvelope(forbiddenGetBody);
    assertMegaSuccessEnvelope(forbiddenDocBody);

    const forbiddenPost = await POST(
      authedRequest(`/docs/${SAMPLE_DOC.id}/comments`, sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "nope" }),
      }),
      { params: Promise.resolve({ segments: ["docs", SAMPLE_DOC.id, "comments"] }) },
    );
    expect(forbiddenPost.status).toBe(200);
    const forbiddenPostBody: unknown = await forbiddenPost.json();
    assertMegaSuccessEnvelope(forbiddenPostBody);

    const missingGet = await GET(authedRequest("/docs/doc_does_not_exist/comments", sessionCookieHeader), {
      params: Promise.resolve({ segments: ["docs", "doc_does_not_exist", "comments"] }),
    });
    const missingDoc = await GET(authedRequest("/docs/doc_does_not_exist", sessionCookieHeader), {
      params: Promise.resolve({ segments: ["docs", "doc_does_not_exist"] }),
    });
    expect(missingGet.status).toBe(missingDoc.status);
    expect(missingGet.status).toBe(404);
    const missingGetBody: unknown = await missingGet.json();
    const missingDocBody: unknown = await missingDoc.json();
    assertMegaFailureEnvelope(missingGetBody);
    assertMegaFailureEnvelope(missingDocBody);
    expect(missingGetBody.error.code).toBe(missingDocBody.error.code);
    expect(missingGetBody.error.messageKey).toBe(missingDocBody.error.messageKey);
    expect(missingGetBody.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);

    const missingPost = await POST(
      authedRequest("/docs/doc_does_not_exist/comments", sessionCookieHeader, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "nope" }),
      }),
      { params: Promise.resolve({ segments: ["docs", "doc_does_not_exist", "comments"] }) },
    );
    expect(missingPost.status).toBe(404);
    const missingPostBody: unknown = await missingPost.json();
    assertMegaFailureEnvelope(missingPostBody);
    expect(missingPostBody.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
  });
});
