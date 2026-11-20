// megaui-only (FSL-117): real-tenant re-test of the Q3 member contract.
//
// Skipped unless FEISHU_LIVE_CONTRACT=1. Credentials come only from the
// environment (loaded from the ignored repo-root .env by the caller); the
// test never prints an email, open_id, token, name or response body.
import { OFFICIAL_FEISHU_ORIGIN } from "@megaui/core";
import { describe, expect, it } from "vitest";

import { FeishuTransport, FeishuTransportError } from "../enterprise/feishu/http";
import { FeishuTokenManager } from "../enterprise/feishu/token";
import { FeishuContactClient } from "./contact";

const enabled = process.env.FEISHU_LIVE_CONTRACT === "1";

interface Exchange {
  readonly path: string;
  readonly status: number;
  readonly code: number | "non-numeric" | "unreadable";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`FSL-117 live re-test requires ${name}`);
  }
  return value;
}

/** Wraps fetch and records every Directory v1 exchange as {path, status, code}. */
function recordingFetch(exchanges: Exchange[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.startsWith("/open-apis/directory/v1/")) {
      // Only a numeric business code is recorded; anything else becomes a
      // fixed marker so a failing assertion can never print a response value.
      let code: number | "non-numeric" | "unreadable";
      try {
        const raw = ((await response.clone().json()) as { code?: unknown }).code;
        code = typeof raw === "number" ? raw : "non-numeric";
      } catch {
        code = "unreadable";
      }
      exchanges.push({ path: url.pathname, status: response.status, code });
    }
    return response;
  }) as typeof fetch;
}

function liveClient(exchanges: Exchange[], forgedToken?: string): FeishuContactClient {
  const credentials = {
    tenantKey: "fsl117-live",
    appId: requireEnv("FEISHU_APP_ID"),
    appSecret: requireEnv("FEISHU_APP_SECRET"),
  };
  const transport = new FeishuTransport({
    target: { provider: "feishu", origin: OFFICIAL_FEISHU_ORIGIN },
    fetchImpl: recordingFetch(exchanges),
  });
  return forgedToken === undefined
    ? new FeishuContactClient({
        transport,
        credentials,
        tokenManager: new FeishuTokenManager({ transport }),
      })
    : new FeishuContactClient({ transport, credentials, getToken: async () => forgedToken });
}

describe.skipIf(!enabled)("FSL-117 live Directory v1 mget (Q3)", () => {
  it("FSL-117 Q3 success", async () => {
    const email = requireEnv("FEISHU_TEST_USER_EMAIL");
    const exchanges: Exchange[] = [];
    const client = liveClient(exchanges);
    const found = await client.findByEmail(email);
    expect(found.kind).toBe("unique");
    const openId = found.kind === "unique" ? found.openId : "ou_fsl117_missing";
    const member = await client.readMember(openId);
    expect(exchanges).toStrictEqual([
      { path: "/open-apis/directory/v1/employees/search", status: 200, code: 0 },
      { path: "/open-apis/directory/v1/employees/mget", status: 200, code: 0 },
    ]);
    expect(member.kind).toBe("active");
    expect(member.kind === "active" && member.name.trim() !== "").toBe(true);
  }, 30_000);

  it("FSL-117 Q3 forged", async () => {
    requireEnv("FEISHU_TEST_USER_EMAIL");
    const exchanges: Exchange[] = [];
    const client = liveClient(exchanges, "t-fsl117forgedtokenvalue0000000000");
    const error = await client.readMember("ou_fsl117_synthetic_member").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(exchanges).toStrictEqual([
      { path: "/open-apis/directory/v1/employees/mget", status: 400, code: 99991663 },
    ]);
    expect(error).toBeInstanceOf(FeishuTransportError);
    expect((error as FeishuTransportError).code).toBe("transport_permanent");
    expect((error as FeishuTransportError).status).toBe(400);
  }, 30_000);
});
