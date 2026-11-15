/**
 * WA-03 BFF contract tests: session guard, envelope shape, error mapping, dispatch.
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import {
  MEGA_ERROR_CODES,
  MegaForbiddenError,
  MegaNotFoundError,
} from "@megaui/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "../../app/api/mega/[...segments]/route";
import {
  dispatchMegaRequest,
  readMegaRequestBody,
  registerMegaRoute,
  resetMegaRouteRegistryForTests,
} from "../../lib/adapter/dispatch";
import {
  assertMegaFailureEnvelope,
  assertMegaSuccessEnvelope,
} from "../../lib/adapter/envelope";
import { mapMegaErrorToHttpResponse } from "../../lib/adapter/errors";

const fixture = ownedContractFixture();
afterAll(() => fixture.close(), 120_000);

describe("WA-03 mega BFF contract", () => {
  let sessionCookieHeader: string;

  beforeAll(async () => {
    await fixture.start();
    sessionCookieHeader = await fixture.mint();
  }, 120_000);

  beforeEach(() => {
    resetMegaRouteRegistryForTests();
  });

  it("returns 401 with stable unauthorized code for unauthenticated GET", async () => {
    const response = await GET(
      new Request("http://127.0.0.1:3000/api/mega/home"),
      { params: Promise.resolve({ segments: ["home"] }) },
    );
    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    assertMegaFailureEnvelope(body);
    expect(body.error.code).toBe(MEGA_ERROR_CODES.UNAUTHORIZED);
    expect(body.error.messageKey).toBe("errors.auth.unauthorized");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("serializes success and failure envelopes for UI-04 fetcher", async () => {
    const success = { data: { ok: true } };
    assertMegaSuccessEnvelope(success);
    expect(success.data).toEqual({ ok: true });

    const { status, body } = mapMegaErrorToHttpResponse(
      new MegaNotFoundError("Doc", "42"),
      new Request("http://127.0.0.1:3000/api/mega/docs/42", {
        headers: { "Accept-Language": "zh-CN,zh;q=0.9" },
      }),
    );
    expect(status).toBe(404);
    assertMegaFailureEnvelope(body);
    expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
    expect(body.error.messageKey).toBe("errors.mega.notFound");
    expect(body.error.message).toContain("未找到");
  });

  it("maps forbidden errors to 403 with i18n messageKey", () => {
    const { status, body } = mapMegaErrorToHttpResponse(
      new MegaForbiddenError("denied"),
      new Request("http://127.0.0.1:3000/api/mega/docs"),
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe(MEGA_ERROR_CODES.FORBIDDEN);
    expect(body.error.messageKey).toBe("errors.mega.forbidden");
  });

  it("returns 404 domain error for unregistered dispatch segments", async () => {

    const response = await GET(
      new Request("http://127.0.0.1:3000/api/mega/unknown-route", {
        headers: { Cookie: sessionCookieHeader },
      }),
      { params: Promise.resolve({ segments: ["unknown-route"] }) },
    );
    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    assertMegaFailureEnvelope(body);
    expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
  });

  it("supports extensible dispatch registration", async () => {
    registerMegaRoute({
      match: (method, segments) =>
        method === "GET" && segments.length === 1 && segments[0] === "ping",
      handle: async () => ({ pong: true }),
    });

    const result = await dispatchMegaRequest({
      method: "GET",
      segments: ["ping"],
      searchParams: new URLSearchParams(),
      body: undefined,
      headers: new Headers(),
    });
    expect(result).toEqual({ pong: true });
  });

  it("throws domain 404 for unregistered segments at dispatch layer", async () => {
    await expect(
      dispatchMegaRequest({
        method: "GET",
        segments: ["missing"],
        searchParams: new URLSearchParams(),
        body: undefined,
        headers: new Headers(),
      }),
    ).rejects.toBeInstanceOf(MegaNotFoundError);
  });

  it("keeps success envelope when handler returns undefined", async () => {
    registerMegaRoute({
      match: (method, segments) =>
        method === "DELETE" && segments.length === 1 && segments[0] === "noop",
      handle: async () => undefined,
    });

    const { DELETE } = await import("../../app/api/mega/[...segments]/route");
    const response = await DELETE(
      new Request("http://127.0.0.1:3000/api/mega/noop", {
        headers: { Cookie: sessionCookieHeader },
      }),
      { params: Promise.resolve({ segments: ["noop"] }) },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    assertMegaSuccessEnvelope(body);
    expect(body.data).toBeNull();
  });

  it("rejects invalid JSON bodies with 400", async () => {
    await expect(
      readMegaRequestBody(
        new Request("http://127.0.0.1:3000/api/mega/docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not-json",
        }),
      ),
    ).rejects.toThrow(/valid JSON/);

    const response = await POST(
      new Request("http://127.0.0.1:3000/api/mega/docs", {
        method: "POST",
        headers: {
          Cookie: sessionCookieHeader,
          "Content-Type": "application/json",
        },
        body: "{not-json",
      }),
      { params: Promise.resolve({ segments: ["docs"] }) },
    );
    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    assertMegaFailureEnvelope(body);
    expect(body.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
  });
});
