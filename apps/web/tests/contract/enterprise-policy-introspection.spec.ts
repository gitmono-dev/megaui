/** FS-64 persistent policy introspection contract. */
import { describe, expect, it } from "vitest";

import {
  createEnterpriseIntrospectionHandler,
  type EnterpriseEligibilityRequest,
} from "../../lib/enterprise-introspection";

const KEY = "fs64-independent-service-key";
const eligibility: EnterpriseEligibilityRequest = {
  localUserId: "fs64-user",
  identityId: "fs64-identity",
  authEpoch: 3,
};

function request(body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/internal/enterprise/eligibility", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("FS-64 persistent policy introspection", () => {
  it("accepts only the strict policy discriminant and returns the shared DTO", async () => {
    const policy = {
      schema_version: 1 as const,
      effective_mode: "enterprise" as const,
      policy_epoch: 7,
      instance_id: "fs64",
      artifact_sha: "a".repeat(64),
    };
    const handler = createEnterpriseIntrospectionHandler({
      expectedKey: () => KEY,
      qualify: async () => true,
      policy: async () => policy,
    });
    const response = await handler(request({ op: "policy" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(policy);
    expect((await handler(request({ op: "policy", extra: true }))).status).toBe(400);
    expect((await handler(request({ op: "unknown" }))).status).toBe(400);
    expect((await handler(request({ op: "policy", ...eligibility }))).status).toBe(400);
  });

  it("does not return a stale policy when the current policy reader is unavailable", async () => {
    const handler = createEnterpriseIntrospectionHandler({
      expectedKey: () => KEY,
      qualify: async () => true,
      policy: async () => null,
    });
    const response = await handler(request({ op: "policy" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "ENTERPRISE_INTROSPECTION_UNAVAILABLE" } });
  });
});
