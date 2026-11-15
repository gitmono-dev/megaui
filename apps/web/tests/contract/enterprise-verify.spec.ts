// megaui-only (FS-14): the Web-facing verify endpoint keeps its opaque
// cookie/input/error contract; real PG/session semantics live in the auth
// integration suite.
import { describe, expect, it } from "vitest";

import { createAuth } from "@megaui/auth";
import type { EmailSender } from "@megaui/email";

const auth = createAuth({
  appName: "megaui-contract",
  secret: "contract-secret-at-least-32-characters-long",
  baseURL: "http://localhost:3000",
  db: {} as never,
  email: {
    sendVerificationEmail: async () => ({ success: true as const }),
    sendResetPasswordEmail: async () => ({ success: true as const }),
  } as unknown as EmailSender,
  nodeEnv: "test",
  trustedOrigins: { appBaseUrl: "http://localhost:3000" },
  enterprisePairing: {
    pairingPort: async () => ({ kind: "unavailable" as const }),
    resolveTransport: () => ({ peerAddress: "127.0.0.1" }),
    verifyPort: async () => ({ kind: "invalid" as const }),
  },
});

describe("enterprise verify Web contract (FS-14)", () => {
  it("rejects a missing flow cookie without calling the verify port", async () => {
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/enterprise/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: "00000000-0000-4000-8000-000000000000", code: "A2B3C4D5" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_INPUT" });
  });

  it("does not expose a session token on invalid verification", async () => {
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/enterprise/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__Host-megaui.enterprise-flow=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      body: JSON.stringify({ challengeId: "00000000-0000-4000-8000-000000000000", code: "A2B3C4D5" }),
    }));
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(body).not.toContain("token");
  });
});
