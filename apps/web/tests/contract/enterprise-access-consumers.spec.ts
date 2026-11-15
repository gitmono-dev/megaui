/** FS-30 consumer contracts: every sensitive consumer uses the FS-15 actor gate. */
import { describe, expect, it } from "vitest";

import {
  AGENT_AUTH_MAX_REVOKE_LATENCY_MS,
  AGENT_AUTH_REVALIDATION_INTERVAL_MS,
  shouldRevalidateAgentAccess,
} from "../../lib/adapter/handlers/agent-stream";
import { buildCollabSessionContext } from "../../lib/adapter/handlers/collab-token";
import type { WebActor } from "../../lib/enterprise-session";

const enterpriseActor: WebActor = {
  kind: "enterprise",
  userId: "fs30-user",
  identityId: "fs30-identity",
  authEpoch: 9,
  backendUsername: "Frozen.Backend_User",
  sessionId: "fs30-session",
};

describe("FS-30 enterprise access consumers", () => {
  it("uses the frozen backend username when minting a collab context", () => {
    expect(buildCollabSessionContext(enterpriseActor)).toEqual({
      userId: "fs30-user",
      username: "Frozen.Backend_User",
      enterprise: { identityId: "fs30-identity", authEpoch: 9 },
    });
  });

  it("does not substitute the local id when an enterprise username is absent", () => {
    expect(() => buildCollabSessionContext({
      ...enterpriseActor,
      backendUsername: "",
    })).toThrow(/backend username/);
  });

  it("revalidates streams at 15 seconds and keeps the 30-second bound explicit", () => {
    expect(AGENT_AUTH_REVALIDATION_INTERVAL_MS).toBe(15_000);
    expect(AGENT_AUTH_MAX_REVOKE_LATENCY_MS).toBe(30_000);
    expect(shouldRevalidateAgentAccess(10_000, 24_999)).toBe(false);
    expect(shouldRevalidateAgentAccess(10_000, 25_000)).toBe(true);
  });
});
