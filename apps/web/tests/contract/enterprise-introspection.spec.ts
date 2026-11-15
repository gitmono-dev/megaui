/** FS-41 service-key protected enterprise eligibility introspection contract. */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { authMiddleware } from "../../middlewares/auth";
import {
  createEnterpriseIntrospectionHandler,
  type EnterpriseEligibilityRequest,
} from "../../lib/enterprise-introspection";

const KEY = "fs41-independent-service-key";
const input: EnterpriseEligibilityRequest = {
  localUserId: "fs41-user",
  identityId: "fs41-identity",
  authEpoch: 3,
};

function request(body: unknown, authorization = `Bearer ${KEY}`): Request {
  return new Request("http://127.0.0.1:3000/api/internal/enterprise/eligibility", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("FS-41 enterprise eligibility introspection", () => {
  it("allows only the exact POST path through auth middleware", async () => {
    const exact = await authMiddleware(new NextRequest(
      "http://127.0.0.1:3000/api/internal/enterprise/eligibility",
      { method: "POST" },
    ));
    expect(exact).toBeUndefined();

    const nested = await authMiddleware(new NextRequest(
      "http://127.0.0.1:3000/api/internal/enterprise/eligibility/extra",
      { method: "POST" },
    ));
    expect(nested?.status).toBe(401);
  });

  it("rejects an incorrect independent service key before touching qualification", async () => {
    const qualify = vi.fn(async () => true);
    const handler = createEnterpriseIntrospectionHandler({
      expectedKey: () => KEY,
      qualify,
    });
    const response = await handler(request(input, "Bearer wrong"));
    expect(response.status).toBe(401);
    expect(qualify).not.toHaveBeenCalled();
  });

  it("does not fall back to the collab ticket secret when introspection key is missing", async () => {
    const handler = createEnterpriseIntrospectionHandler({
      expectedKey: () => undefined,
      qualify: async () => true,
    });
    const response = await handler(request(input, "Bearer collab-ticket-secret"));
    expect(response.status).toBe(401);
  });

  it("strictly validates identity and epoch input", async () => {
    const qualify = vi.fn(async () => true);
    const handler = createEnterpriseIntrospectionHandler({ expectedKey: () => KEY, qualify });
    expect((await handler(request({ ...input, authEpoch: -1 }))).status).toBe(400);
    expect((await handler(request({ ...input, extra: "nope" }))).status).toBe(400);
    expect((await handler(request({ localUserId: input.localUserId, identityId: input.identityId }))).status).toBe(400);
    expect(qualify).not.toHaveBeenCalled();
  });

  it("returns the current qualification result and no session/token fields", async () => {
    const qualify = vi.fn(async (value: EnterpriseEligibilityRequest) => value.authEpoch === 3);
    const handler = createEnterpriseIntrospectionHandler({ expectedKey: () => KEY, qualify });
    const response = await handler(request(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ eligible: true });
    expect(JSON.stringify(await (await handler(request({ ...input, authEpoch: 4 }))).json())).not.toContain("token");
    expect(qualify).toHaveBeenCalledWith(input);
  });

  it("fails closed when the current qualification authority is unavailable", async () => {
    const handler = createEnterpriseIntrospectionHandler({
      expectedKey: () => KEY,
      qualify: async () => null,
    });
    const response = await handler(request(input));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "ENTERPRISE_INTROSPECTION_UNAVAILABLE" } });
  });
});
