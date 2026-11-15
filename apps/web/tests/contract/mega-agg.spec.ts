/**
 * WA-05 aggregation-domain BFF contract tests (chat/releases/notifications/search/settings/credentials/collab + internal email).
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import { COLLAB_TICKET_PREFIX, COLLAB_TICKET_PREFIX_V2, COLLAB_TICKET_TTL_MS } from "@megaui/core/collab/ticket";
import {
  MEGA_ERROR_CODES,
  SearchCjkScaleExceededError,
} from "@megaui/engine";
import { SAMPLE_CHANNEL, SAMPLE_DOC } from "@megaui/engine/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as postInternalEmail } from "../../app/api/internal/notifications/email/route";
import { GET, POST } from "../../app/api/mega/[...segments]/route";
import { assertMegaFailureEnvelope, assertMegaSuccessEnvelope } from "../../lib/adapter/envelope";
import * as searchWorkspaceModule from "../../lib/adapter/search-workspace";
import {
  MemoryIdempotencyStore,
  setInternalEmailIdempotencyStoreForTests,
  setInternalEmailSenderForTests,
} from "../../lib/internal/notifications-email";

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

describe(
  "WA-05 mega aggregation BFF contract",
  () => {
    let sessionCookieHeader: string;
    const internalBearer = "wa05-internal-mail-bearer";
    const collabSecret = "wa05-collab-internal-token";

    beforeAll(async () => {
      await fixture.start();

      process.env.MEGA2_INTERNAL_MAIL_BEARER = internalBearer;
      process.env.MEGA_COLLAB_INTERNAL_TOKEN = collabSecret;
      process.env.MEGA2_PUBLIC_BASE_URL =
        process.env.MEGA2_PUBLIC_BASE_URL ?? "http://127.0.0.1:19180";

      sessionCookieHeader = await fixture.mint();
    }, 60_000);

    afterEach(() => {
      vi.restoreAllMocks();
      setInternalEmailSenderForTests(null);
      setInternalEmailIdempotencyStoreForTests(null);
    });

    describe("chat domain", () => {
      it("lists channels for the authenticated actor", async () => {
        const response = await GET(
          authedRequest("/channels", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["channels"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(Array.isArray(body.data)).toBe(true);
      });

      it("returns 401 without a session cookie", async () => {
        const response = await GET(
          unauthedRequest("/channels"),
          { params: Promise.resolve({ segments: ["channels"] }) },
        );
        expect(response.status).toBe(401);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.UNAUTHORIZED);
      });

      it("returns 404 for messages on a missing channel", async () => {
        const response = await GET(
          authedRequest("/channels/chn_missing/messages", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["channels", "chn_missing", "messages"] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
      });

      it("returns 403 when listing messages on a private channel without membership", async () => {
        const createResponse = await POST(
          authedRequest("/channels", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `wa05-private-${Date.now()}`,
              visibility: "private",
            }),
          }),
          { params: Promise.resolve({ segments: ["channels"] }) },
        );
        const createBody: unknown = await createResponse.json();
        assertMegaSuccessEnvelope(createBody);
        const channelId = (createBody.data as { id: string }).id;

        const secondSession = await fixture.mint();
        const response = await GET(
          authedRequest(`/channels/${channelId}/messages`, secondSession),
          { params: Promise.resolve({ segments: ["channels", channelId, "messages"] }) },
        );
        expect(response.status).toBe(403);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.FORBIDDEN);
      }, 60_000);
    });

    describe("releases domain", () => {
      it("lists releases for the authenticated actor", async () => {
        const response = await GET(
          authedRequest("/releases", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["releases"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({ items: expect.any(Array) });
      });

      it("returns 401 without a session cookie", async () => {
        const response = await GET(
          unauthedRequest("/releases"),
          { params: Promise.resolve({ segments: ["releases"] }) },
        );
        expect(response.status).toBe(401);
      });

      it("returns 404 for a missing release", async () => {
        const response = await GET(
          authedRequest("/releases/rel_does_not_exist", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["releases", "rel_does_not_exist"] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
      });
    });

    describe("notifications domain", () => {
      it("lists notifications for the authenticated actor", async () => {
        const response = await GET(
          authedRequest("/notifications", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["notifications"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({ items: expect.any(Array) });
      });

      it("returns 401 without a session cookie", async () => {
        const response = await GET(
          unauthedRequest("/notifications"),
          { params: Promise.resolve({ segments: ["notifications"] }) },
        );
        expect(response.status).toBe(401);
      });

      it("returns 404 when marking a missing notification read", async () => {
        const response = await POST(
          authedRequest("/notifications/ntf_missing/read", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ segments: ["notifications", "ntf_missing", "read"] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
      });
    });

    describe("search domain", () => {
      it("returns workspace search results for a non-empty query", async () => {
        const response = await GET(
          authedRequest("/search?q=architecture", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["search"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({
          issues: expect.any(Array),
          cls: expect.any(Array),
          docs: expect.any(Array),
          files: [],
          body: expect.any(Object),
        });
      });

      it("returns 401 without a session cookie", async () => {
        const response = await GET(
          unauthedRequest("/search?q=test"),
          { params: Promise.resolve({ segments: ["search"] }) },
        );
        expect(response.status).toBe(401);
      });

      it("maps SearchCjkScaleExceededError to HTTP 503 with the pinned envelope", async () => {
        vi.spyOn(searchWorkspaceModule, "searchWorkspace").mockRejectedValue(
          new SearchCjkScaleExceededError(200_001, 200_000),
        );

        const response = await GET(
          authedRequest("/search?q=全文", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["search"] }) },
        );
        expect(response.status).toBe(503);
        const body: unknown = await response.json();
        expect(body).toEqual({
          error: {
            code: "SEARCH_CJK_SCALE_EXCEEDED",
            messageKey: "errors.search.cjkScaleExceeded",
          },
        });
      });
    });

    describe("profile-prefs", () => {
      it("returns profile prefs for the authenticated actor", async () => {
        const response = await GET(
          authedRequest("/profile-prefs", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["profile-prefs"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({
          username: expect.any(String),
          bio: expect.any(String),
        });
      });

      it("returns 401 without a session cookie", async () => {
        const response = await GET(
          unauthedRequest("/profile-prefs"),
          { params: Promise.resolve({ segments: ["profile-prefs"] }) },
        );
        expect(response.status).toBe(401);
      });
    });

    describe("collab-token", () => {
      it("returns 401 when unauthenticated", async () => {
        const response = await GET(
          unauthedRequest("/collab/token"),
          { params: Promise.resolve({ segments: ["collab", "token"] }) },
        );
        expect(response.status).toBe(401);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.UNAUTHORIZED);
      });

      it("returns a short-lived ticket when authenticated", async () => {
        const beforeMs = Date.now();
        const response = await GET(
          authedRequest("/collab/token", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["collab", "token"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        const record = body.data as { token: string; userId: string; expiresAtMs: number };
        expect(record.token).toEqual(expect.any(String));
        expect(record.userId).toEqual(expect.any(String));
        expect(record.expiresAtMs).toBeGreaterThan(beforeMs);
        expect(record.expiresAtMs).toBeLessThanOrEqual(beforeMs + COLLAB_TICKET_TTL_MS + 5_000);
        expect(record.token.startsWith(COLLAB_TICKET_PREFIX)).toBe(true);
      });

      it("mints a v2 ticket for a public channel room and rejects illegal rooms", async () => {
        const response = await GET(
          authedRequest(
            `/collab/token?room=${encodeURIComponent(`collection:channel:${SAMPLE_CHANNEL.id}`)}`,
            sessionCookieHeader,
          ),
          { params: Promise.resolve({ segments: ["collab", "token"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        const record = body.data as { token: string };
        expect(record.token.startsWith(COLLAB_TICKET_PREFIX_V2)).toBe(true);

        const illegal = await GET(
          authedRequest(
            `/collab/token?room=${encodeURIComponent("collection:inbox:user-1")}`,
            sessionCookieHeader,
          ),
          { params: Promise.resolve({ segments: ["collab", "token"] }) },
        );
        expect(illegal.status).toBe(400);
        const illegalBody: unknown = await illegal.json();
        assertMegaFailureEnvelope(illegalBody);
        expect(illegalBody.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
      });

      it("returns 403 when a non-member requests a private channel room", async () => {
        const createResponse = await POST(
          authedRequest("/channels", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `rt04-private-${Date.now()}`,
              visibility: "private",
            }),
          }),
          { params: Promise.resolve({ segments: ["channels"] }) },
        );
        const createBody: unknown = await createResponse.json();
        assertMegaSuccessEnvelope(createBody);
        const channelId = (createBody.data as { id: string }).id;
        const secondSession = await fixture.mint();
        const response = await GET(
          authedRequest(
            `/collab/token?room=${encodeURIComponent(`collection:channel:${channelId}`)}`,
            secondSession,
          ),
          { params: Promise.resolve({ segments: ["collab", "token"] }) },
        );
        expect(response.status).toBe(403);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.FORBIDDEN);
      }, 60_000);

      it("returns 401 when a room ticket is requested without a session", async () => {
        const response = await GET(
          unauthedRequest(`/collab/token?room=collection:channel:${SAMPLE_CHANNEL.id}`),
          { params: Promise.resolve({ segments: ["collab", "token"] }) },
        );
        expect(response.status).toBe(401);
      });
    });

    describe("internal notifications email", () => {
      const emailPayload = {
        event_type: "issue.comment.created",
        recipient: { username: "tester", email: "tester@example.com" },
        locale: "en",
        payload: {
          actorUsername: "alice",
          issueLink: "https://example.com/issues/1",
          issueTitle: "Bug",
          commentExcerpt: "Looks good",
        },
      };

      it("returns 401 when bearer is missing", async () => {
        const response = await postInternalEmail(
          new Request("http://127.0.0.1:3000/api/internal/notifications/email", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "wa05-missing-bearer",
            },
            body: JSON.stringify(emailPayload),
          }),
        );
        expect(response.status).toBe(401);
      });

      it("returns 401 when bearer is wrong", async () => {
        const response = await postInternalEmail(
          new Request("http://127.0.0.1:3000/api/internal/notifications/email", {
            method: "POST",
            headers: {
              Authorization: "Bearer wrong-token",
              "Content-Type": "application/json",
              "Idempotency-Key": "wa05-wrong-bearer",
            },
            body: JSON.stringify(emailPayload),
          }),
        );
        expect(response.status).toBe(401);
      });

      it("accepts a valid bearer with idempotency and returns 202", async () => {
        setInternalEmailSenderForTests(async () => ({ ok: true }));
        setInternalEmailIdempotencyStoreForTests(new MemoryIdempotencyStore());

        const response = await postInternalEmail(
          new Request("http://127.0.0.1:3000/api/internal/notifications/email", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${internalBearer}`,
              "Content-Type": "application/json",
              "Idempotency-Key": "wa05-accept-1",
            },
            body: JSON.stringify(emailPayload),
          }),
        );
        expect(response.status).toBe(202);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ accepted: true, duplicate: false });
      });

      it("returns duplicate:true for the same idempotency key and body", async () => {
        setInternalEmailSenderForTests(async () => ({ ok: true }));
        setInternalEmailIdempotencyStoreForTests(new MemoryIdempotencyStore());

        const requestInit = {
          method: "POST" as const,
          headers: {
            Authorization: `Bearer ${internalBearer}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "wa05-dup-key",
          },
          body: JSON.stringify(emailPayload),
        };

        const first = await postInternalEmail(
          new Request("http://127.0.0.1:3000/api/internal/notifications/email", requestInit),
        );
        expect(first.status).toBe(202);

        const second = await postInternalEmail(
          new Request("http://127.0.0.1:3000/api/internal/notifications/email", requestInit),
        );
        expect(second.status).toBe(202);
        const body: unknown = await second.json();
        expect(body).toMatchObject({ accepted: true, duplicate: true });
      });
    });

    describe("credentials domain", () => {
      function stubMega2CredentialsFetch(): void {
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/v1/user/token/list")) {
            return new Response(
              JSON.stringify({
                req_result: true,
                data: [{ id: 7, token: "****wxyz", created_at: 1_700_000_000 }],
                err_message: "",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/api/v1/user/token/generate")) {
            return new Response(
              JSON.stringify({
                req_result: true,
                data: "plain-token-once",
                err_message: "",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("not found", { status: 404 });
        }));
      }

      it("lists personal access tokens with maskedToken only", async () => {
        stubMega2CredentialsFetch();
        const response = await GET(
          authedRequest("/user/tokens", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["user", "tokens"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        const tokens = body.data as Array<{ maskedToken: string; token?: string }>;
        expect(tokens).toHaveLength(1);
        expect(tokens[0]?.maskedToken).toBe("****wxyz");
        expect(tokens[0]?.token).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain("plain-token-once");
      });

      it("returns the plaintext token only on generate", async () => {
        stubMega2CredentialsFetch();
        const response = await POST(
          authedRequest("/user/tokens/generate", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ segments: ["user", "tokens", "generate"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toEqual({ token: "plain-token-once" });

        const listResponse = await GET(
          authedRequest("/user/tokens", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["user", "tokens"] }) },
        );
        const listBody: unknown = await listResponse.json();
        assertMegaSuccessEnvelope(listBody);
        expect(JSON.stringify(listBody)).not.toContain("plain-token-once");
      });

      it("returns 401 without a session cookie", async () => {
        const response = await GET(
          unauthedRequest("/user/tokens"),
          { params: Promise.resolve({ segments: ["user", "tokens"] }) },
        );
        expect(response.status).toBe(401);
      });
    });

    describe("seeded channel sanity", () => {
      it("exposes seeded channel messages to members", async () => {
        const response = await GET(
          authedRequest(`/channels/${SAMPLE_CHANNEL.id}/messages`, sessionCookieHeader),
          { params: Promise.resolve({
            segments: ["channels", SAMPLE_CHANNEL.id, "messages"],
          }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(Array.isArray(body.data)).toBe(true);
      });
    });

    describe("docs ACL regression hook", () => {
      it("returns a seeded workspace doc to another signed-in user", async () => {
        const response = await GET(
          authedRequest(`/docs/${SAMPLE_DOC.id}`, sessionCookieHeader),
          { params: Promise.resolve({ segments: ["docs", SAMPLE_DOC.id] }) },
        );
        expect(response.status).toBe(200);
      });
    });
  },
);
