/**
 * FSL-128: collab in Feishu mode (`AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`).
 *
 * AC1 startup needs no policy service configuration; AC2 valid ordinary
 * tickets are accepted; AC3 invalid or expired tickets are rejected.
 * FSL-132 AC24/AC25: `maintenance` and `enterprise` without `AUTH_PROVIDER`
 * refuse to start with `INVALID_AUTH_PROVIDER` (FSL-128's AC4, the old
 * enterprise behaviour without a provider, is gone).
 * FSL-134 AC6-AC9: in Feishu and legacy mode a valid ticket is accepted and an
 * invalid or expired one is rejected; the enterprise policy bridge, the former
 * v3 tickets and the startup mode check of the old policy module are gone, and
 * the shared `resolveAuthMode` alone refuses an invalid pair at startup.
 * Real Hocuspocus server + provider clients.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { createHmac } from "node:crypto";

import { AuthModeError } from "@megaui/core";
import { mintCollabTicket } from "@megaui/core/collab/ticket";

import { createMapDocAccess, isFeishuCollabMode } from "./auth";
import { createCollabServer, type CollabServerHandle } from "./server";

const SECRET = "fsl128-ticket-secret";
const DOC_ROOM = "container:doc:fsl128";
const CHANNEL_ROOM = "collection:channel:fsl128";
/** Keys of the removed policy bridge; a leftover value must change nothing. */
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

async function startServer(): Promise<CollabServerHandle> {
  const handle = createCollabServer({
    port: 0,
    quiet: true,
    ticketSecret: SECRET,
    resolveDocAccess: editorAccess,
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

/** A correctly signed token in the removed v3 format (user, identity, epoch, expiry, room). */
function formerV3Token(room: string): string {
  const body = ["user-a", "identity-a", "4", String(Date.now() + 60_000), room].join(".");
  return `mega-collab.v3.${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
}

/** The two modes collab accepts, as `[label, AUTH_MODE, AUTH_PROVIDER]`. */
const MODES = [
  ["Feishu (enterprise + feishu)", "enterprise", "feishu"],
  ["legacy (AUTH_MODE unset)", undefined, undefined],
  ["legacy (legacy + local)", "legacy", "local"],
] as const;

describe("FSL-128 isFeishuCollabMode (resolveAuthMode)", () => {
  it.each([
    [undefined, undefined, false],
    ["legacy", undefined, false],
    ["legacy", "local", false],
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
    ["enterprise", undefined],
    ["enterprise", "  "],
    ["maintenance", undefined],
    ["maintenance", "local"],
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

  it("AC1: leftover or partial enterprise policy keys change nothing and contact no service", async () => {
    stubMode("enterprise", "feishu");
    vi.stubEnv("ENTERPRISE_INTROSPECTION_KEY", "fsl128-leftover-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const handle = await startServer();

    const { outcome } = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM }));
    expect(outcome).toBe("synced");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe.each(MODES)("FSL-134 collab in %s mode", (_label, mode, provider) => {
  it("ignores the full old policy configuration: starts, never fetches, /health has no policy fields", async () => {
    stubMode(mode, provider);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:1");
    vi.stubEnv("ENTERPRISE_INTROSPECTION_KEY", "fsl134-leftover-key");
    vi.stubEnv("ENTERPRISE_DB_INSTANCE_ID", "fsl134");
    vi.stubEnv("ENTERPRISE_ARTIFACT_SHA", "a".repeat(64));
    vi.stubEnv("ENTERPRISE_COLLAB_REVOKE_KEY", "fsl134-leftover-revoke-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const handle = await startServer();

    const { outcome } = await connect(handle, DOC_ROOM, mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM }));
    expect(outcome).toBe("synced");
    expect(fetchSpy).not.toHaveBeenCalled();
    const health = await fetch(httpUrl(handle, "/health"));
    expect(health.status).toBe(200);
    expect(Object.keys(await health.json() as Record<string, unknown>).sort())
      .toEqual(["connections", "documents", "ok", "service"]);
  });

  it("AC6/AC7: accepts valid ordinary tickets (v1/v2, document and channel rooms)", async () => {
    stubMode(mode, provider);
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

  it("AC8: rejects invalid tickets, including a correctly signed one in the former v3 format", async () => {
    stubMode(mode, provider);
    const handle = await startServer();

    const rejected: Array<[string, string]> = [
      [DOC_ROOM, "not-a-ticket"],
      [DOC_ROOM, ""],
      [DOC_ROOM, mintCollabTicket("user-a", "another-secret", { roomName: DOC_ROOM })],
      [CHANNEL_ROOM, mintCollabTicket("user-a", SECRET, { roomName: "collection:channel:other" })],
      // Valid signature but no document access is still refused.
      ["container:doc:no-access", mintCollabTicket("user-a", SECRET, { roomName: "container:doc:no-access" })],
      [DOC_ROOM, formerV3Token(DOC_ROOM)],
      [CHANNEL_ROOM, formerV3Token(CHANNEL_ROOM)],
    ];
    const valid = mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM });
    const tampered = `${valid.slice(0, -2)}${valid.endsWith("AA") ? "BB" : "AA"}`;
    rejected.push([DOC_ROOM, tampered]);

    for (const [room, token] of rejected) {
      const { outcome } = await connect(handle, room, token);
      expect(outcome, `${room} ${token.slice(0, 16)}`).toBe("rejected");
    }
    expect(handle.connectionCount()).toBe(0);
  });

  it("AC9: rejects expired tickets (v1 and v2, document and channel rooms)", async () => {
    stubMode(mode, provider);
    const handle = await startServer();
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    const justExpired = { nowMs: Date.now() - 2_000, ttlMs: 1_000 };

    const expired: Array<[string, string]> = [
      [DOC_ROOM, mintCollabTicket("user-a", SECRET, { nowMs: twoHoursAgo })],
      [DOC_ROOM, mintCollabTicket("user-a", SECRET, { roomName: DOC_ROOM, nowMs: twoHoursAgo })],
      [DOC_ROOM, mintCollabTicket("user-a", SECRET, justExpired)],
      [CHANNEL_ROOM, mintCollabTicket("user-a", SECRET, { roomName: CHANNEL_ROOM, ...justExpired })],
    ];
    for (const [room, token] of expired) {
      const { outcome } = await connect(handle, room, token);
      expect(outcome).toBe("rejected");
    }
    expect(handle.connectionCount()).toBe(0);
  });
});

function startupError(): unknown {
  try {
    handles.push(createCollabServer({ port: 0, quiet: true, ticketSecret: SECRET }));
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("FSL-132 collab refuses maintenance and enterprise without AUTH_PROVIDER", () => {
  it.each([
    ["AC24 AUTH_MODE=maintenance", "maintenance", undefined],
    ["AC24 AUTH_MODE=maintenance, AUTH_PROVIDER=local", "maintenance", "local"],
    ["AC25 AUTH_MODE=enterprise, AUTH_PROVIDER unset", "enterprise", undefined],
    ["AC25 AUTH_MODE=enterprise, blank AUTH_PROVIDER", "enterprise", "  "],
    ["AC25 AUTH_MODE=enterprise, empty AUTH_PROVIDER", "enterprise", ""],
  ] as const)("%s: startup throws INVALID_AUTH_PROVIDER", (_label, mode, provider) => {
    stubMode(mode, provider);
    const error = startupError();
    expect(error).toBeInstanceOf(AuthModeError);
    expect((error as AuthModeError).code).toBe("INVALID_AUTH_PROVIDER");
  });

  it("AC25: even with the full old policy configuration it refuses without contacting any service", () => {
    stubMode("enterprise", undefined);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:1");
    vi.stubEnv("ENTERPRISE_INTROSPECTION_KEY", "fsl132-key");
    vi.stubEnv("ENTERPRISE_DB_INSTANCE_ID", "fsl132");
    vi.stubEnv("ENTERPRISE_ARTIFACT_SHA", "a".repeat(64));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const error = startupError();
    expect(error).toBeInstanceOf(AuthModeError);
    expect((error as AuthModeError).code).toBe("INVALID_AUTH_PROVIDER");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("FSL-134: an unknown AUTH_MODE is refused at startup by resolveAuthMode with INVALID_AUTH_MODE", () => {
    for (const mode of ["bogus", "Enterprise", "LEGACY"]) {
      stubMode(mode, undefined);
      const error = startupError();
      expect(error, mode).toBeInstanceOf(AuthModeError);
      expect((error as AuthModeError).code, mode).toBe("INVALID_AUTH_MODE");
    }
  });

  it("FSL-134: an unknown AUTH_PROVIDER is refused at startup with INVALID_AUTH_PROVIDER", () => {
    stubMode("bogus", "other");
    const error = startupError();
    expect(error).toBeInstanceOf(AuthModeError);
    expect((error as AuthModeError).code).toBe("INVALID_AUTH_PROVIDER");
  });

  it("legacy still starts", async () => {
    stubMode("legacy", undefined);
    expect(startupError()).toBeUndefined();
  });
});
