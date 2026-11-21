/**
 * FSL-128: collab in Feishu mode (`AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`).
 *
 * AC1 startup needs no policy service configuration; AC2 valid ordinary
 * tickets are accepted; AC3 invalid or expired tickets are rejected; AC4 an
 * `enterprise` deployment without `AUTH_PROVIDER` keeps its existing
 * behaviour. Real Hocuspocus server + provider clients.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { AuthModeError } from "@megaui/core";
import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { createMapDocAccess, isFeishuCollabMode } from "./auth";
import { EnterprisePolicyError, type EnterprisePolicyBridge } from "./enterprise-policy";
import { createCollabServer, type CollabServerHandle } from "./server";

const SECRET = "fsl128-ticket-secret";
const DOC_ROOM = "container:doc:fsl128";
const CHANNEL_ROOM = "collection:channel:fsl128";
const POLICY = {
  schema_version: 1 as const,
  effective_mode: "enterprise" as const,
  policy_epoch: 4,
  instance_id: "fsl128",
  artifact_sha: "a".repeat(64),
};
const ENTERPRISE_ENV = [
  "BETTER_AUTH_URL",
  "ENTERPRISE_INTROSPECTION_KEY",
  "ENTERPRISE_DB_INSTANCE_ID",
  "ENTERPRISE_ARTIFACT_SHA",
] as const;

const handles: CollabServerHandle[] = [];
const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const handle of handles.splice(0)) await handle.destroy();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubMode(mode: string | undefined, provider: string | undefined): void {
  vi.stubEnv("AUTH_MODE", mode);
  vi.stubEnv("AUTH_PROVIDER", provider);
  // Start from a deployment without any enterprise policy configuration.
  for (const key of ENTERPRISE_ENV) vi.stubEnv(key, undefined);
  vi.stubEnv("MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED", undefined);
}

const editorAccess = createMapDocAccess({
  fsl128: { allow: true, readOnly: false, role: "owner", reason: "editor" },
});

function boundUrl(handle: CollabServerHandle): string {
  const address = handle.server.address;
  const port = typeof address === "object" && address && "port" in address
    ? (address as { port: number }).port
    : handle.port;
  return `ws://127.0.0.1:${port}`;
}

function httpUrl(handle: CollabServerHandle, path: string): string {
  return `${boundUrl(handle).replace("ws://", "http://")}${path}`;
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function startServer(
  extra: { enterprisePolicy?: EnterprisePolicyBridge } = {},
): Promise<CollabServerHandle> {
  const handle = createCollabServer({
    port: 0,
    quiet: true,
    ticketSecret: SECRET,
    resolveDocAccess: editorAccess,
    ...extra,
  });
  handles.push(handle);
  await handle.listen();
  return handle;
}

type Outcome = "synced" | "rejected";

/** Connect one provider and resolve with whether Hocuspocus accepted it. */
async function connect(handle: CollabServerHandle, room: string, token: string): Promise<{
  outcome: Outcome;
  doc: Y.Doc;
}> {
  const doc = new Y.Doc();
  let outcome: Outcome | null = null;
  const provider = new HocuspocusProvider({
    url: boundUrl(handle),
    name: room,
    document: doc,
    token,
    onSynced: () => {
      outcome ??= "synced";
    },
    onAuthenticationFailed: () => {
      outcome ??= "rejected";
    },
  });
  providers.push(provider);
  await waitFor(() => outcome !== null);
  return { outcome: outcome!, doc };
}

function trackingBridge(): EnterprisePolicyBridge & {
  read: ReturnType<typeof vi.fn>;
  qualify: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn(async () => POLICY),
    qualify: vi.fn(async () => true),
  };
}

describe("FSL-128 isFeishuCollabMode (resolveAuthMode)", () => {
  it.each([
    [undefined, undefined, false],
    ["legacy", undefined, false],
    ["legacy", "local", false],
    ["enterprise", undefined, false],
    ["enterprise", "  ", false],
    ["maintenance", undefined, false],
    ["enterprise", "feishu", true],
    [" enterprise ", " feishu ", true],
  ] as const)("AUTH_MODE=%s AUTH_PROVIDER=%s -> %s", (mode, provider, expected) => {
    expect(isFeishuCollabMode({ AUTH_MODE: mode, AUTH_PROVIDER: provider })).toBe(expected);
  });

  it.each([
    ["legacy", "feishu"],
    ["enterprise", "local"],
    ["maintenance", "feishu"],
    ["enterprise", "other"],
  ] as const)("rejects AUTH_MODE=%s AUTH_PROVIDER=%s and collab refuses to start", (mode, provider) => {
    expect(() => isFeishuCollabMode({ AUTH_MODE: mode, AUTH_PROVIDER: provider }))
      .toThrow(AuthModeError);
    stubMode(mode, provider);
    expect(() => createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET }))
      .toThrow(AuthModeError);
  });
});

describe("FSL-128 collab Feishu mode", () => {
  it("AC1: starts without any policy service configuration and never contacts a policy service", async () => {
    stubMode("enterprise", "feishu");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const handle = await startServer();

    const health = await fetch(httpUrl(handle, "/health"));
    expect(health.status).toBe(200);
    const body = await health.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("effective_mode");
    expect(body).not.toHaveProperty("policy_epoch");
    // Only the health probe above went through fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AC1: leftover or partial enterprise policy keys do not build a bridge", async () => {
    stubMode("enterprise", "feishu");
    // Under enterprise without AUTH_PROVIDER this partial set refuses startup.
    vi.stubEnv("ENTERPRISE_INTROSPECTION_KEY", "fsl128-leftover-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const explicit = trackingBridge();
    const handle = await startServer({ enterprisePolicy: explicit });

    const { outcome } = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM }));
    expect(outcome).toBe("synced");
    expect(explicit.read).not.toHaveBeenCalled();
    expect(explicit.qualify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC2: accepts valid ordinary tickets without enterprise fields (v1/v2, document and channel rooms)", async () => {
    stubMode("enterprise", "feishu");
    const handle = await startServer();

    const a = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET));
    const b = await connect(handle, DOC_ROOM, mintCollabTicket("user-b", SECRET, { roomName: DOC_ROOM }));
    expect(a.outcome).toBe("synced");
    expect(b.outcome).toBe("synced");
    a.doc.getText("body").insert(0, "fsl128-feishu");
    await waitFor(() => b.doc.getText("body").toString() === "fsl128-feishu");

    const channel = await connect(handle, CHANNEL_ROOM, mintCollabTicket("user-a", SECRET, { roomName: CHANNEL_ROOM }));
    expect(channel.outcome).toBe("synced");
    expect(handle.connectionCount()).toBe(3);
  });

  it("AC3: rejects invalid or expired tickets", async () => {
    stubMode("enterprise", "feishu");
    const handle = await startServer();
    const hourAgo = Date.now() - 2 * 3_600_000;

    const rejected: Array<[string, string]> = [
      [DOC_ROOM, "not-a-ticket"],
      [DOC_ROOM, ""],
      [DOC_ROOM, mintCollabTicket("user-a", "another-secret", { roomName: DOC_ROOM })],
      [DOC_ROOM, mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM, nowMs: hourAgo })],
      [DOC_ROOM, mintCollabTicket("user-a", SECRET, { nowMs: hourAgo })],
      [CHANNEL_ROOM, mintCollabTicket("user-a", SECRET, { roomName: "collection:channel:other" })],
      // Valid signature but no document access is still refused.
      ["container:doc:no-access", mintCollabTicket("user-a", SECRET, { roomName: "container:doc:no-access" })],
    ];
    const valid = mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM });
    const tampered = `${valid.slice(0, -2)}${valid.endsWith("AA") ? "BB" : "AA"}`;
    rejected.push([DOC_ROOM, tampered]);

    for (const [room, token] of rejected) {
      const { outcome } = await connect(handle, room, token);
      expect(outcome).toBe("rejected");
    }
    expect(handle.connectionCount()).toBe(0);
  });
});

describe("FSL-128 enterprise without AUTH_PROVIDER is unchanged", () => {
  it.each([undefined, "", "  "])("AC4: still requires the policy service configuration (AUTH_PROVIDER=%j)", provider => {
    stubMode("enterprise", provider);
    expect(() => createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET }))
      .toThrow(EnterprisePolicyError);
  });

  it("AC4: an invalid AUTH_MODE still fails with the existing error", () => {
    stubMode("bogus", undefined);
    expect(() => createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET }))
      .toThrow(EnterprisePolicyError);
  });

  it("AC4: reads the policy on startup and refuses startup when it is unavailable", async () => {
    stubMode("enterprise", undefined);
    const handle = createCollabServer({
      port: 0,
      quiet: true,
      ticketSecret: SECRET,
      enterprisePolicy: { read: async () => { throw new EnterprisePolicyError(); } },
    });
    handles.push(handle);
    await expect(handle.listen()).rejects.toBeInstanceOf(EnterprisePolicyError);
  });

  it("AC4: rejects ordinary tickets and accepts only enterprise tickets bound to the current epoch", async () => {
    stubMode("enterprise", undefined);
    const bridge = trackingBridge();
    const handle = await startServer({ enterprisePolicy: bridge });
    expect(bridge.read).toHaveBeenCalled();

    const health = await fetch(httpUrl(handle, "/health"));
    expect(await health.json()).toMatchObject({ effective_mode: "enterprise", policy_epoch: 4 });

    const plain = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM }));
    expect(plain.outcome).toBe("rejected");
    expect(bridge.qualify).not.toHaveBeenCalled();

    const staleEpoch = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET, {
      roomName: DOC_ROOM, identityId: "identity-a", authEpoch: 3,
    }));
    expect(staleEpoch.outcome).toBe("rejected");

    const current = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET, {
      roomName: DOC_ROOM, identityId: "identity-a", authEpoch: 4,
    }));
    expect(current.outcome).toBe("synced");
    expect(bridge.qualify).toHaveBeenCalledWith({
      localUserId: "user-a", identityId: "identity-a", authEpoch: 4,
    });
  });
});
