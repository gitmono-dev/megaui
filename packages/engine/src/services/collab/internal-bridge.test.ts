import { describe, expect, it, vi } from "vitest";
import {
  createCollabInternalBridge,
  isCollabBridgeConfigured,
  resolveCollabInternalToken,
  resolveCollabInternalUrl,
  verifyInternalBridgeToken,
} from "./internal-bridge";

const TOKEN = "internal-bridge-secret-do-not-use-in-prod";
const URL = "http://127.0.0.1:19181";

describe("config resolution (EG-13)", () => {
  it("resolves url/token from an explicit config, trimming trailing slashes", () => {
    expect(resolveCollabInternalUrl({ internalUrl: `${URL}/` })).toBe(URL);
    expect(resolveCollabInternalToken({ token: ` ${TOKEN} ` })).toBe(TOKEN);
  });

  it("falls back to the injected env when no explicit value is given", () => {
    const config = {
      env: { MEGA_COLLAB_INTERNAL_URL: URL, MEGA_COLLAB_INTERNAL_TOKEN: TOKEN },
    };
    expect(resolveCollabInternalUrl(config)).toBe(URL);
    expect(resolveCollabInternalToken(config)).toBe(TOKEN);
  });

  it("prefers explicit config over env", () => {
    const config = {
      internalUrl: "http://explicit:1",
      token: "explicit-token",
      env: { MEGA_COLLAB_INTERNAL_URL: URL, MEGA_COLLAB_INTERNAL_TOKEN: TOKEN },
    };
    expect(resolveCollabInternalUrl(config)).toBe("http://explicit:1");
    expect(resolveCollabInternalToken(config)).toBe("explicit-token");
  });

  it("returns null and reports unconfigured when neither url nor token is set", () => {
    expect(resolveCollabInternalUrl({ env: {} })).toBeNull();
    expect(resolveCollabInternalToken({ env: {} })).toBeNull();
    expect(isCollabBridgeConfigured({ env: {} })).toBe(false);
  });

  it("requires both url and token to report configured", () => {
    expect(isCollabBridgeConfigured({ env: { MEGA_COLLAB_INTERNAL_URL: URL } })).toBe(
      false,
    );
    expect(
      isCollabBridgeConfigured({ env: { MEGA_COLLAB_INTERNAL_TOKEN: TOKEN } }),
    ).toBe(false);
    expect(
      isCollabBridgeConfigured({
        env: { MEGA_COLLAB_INTERNAL_URL: URL, MEGA_COLLAB_INTERNAL_TOKEN: TOKEN },
      }),
    ).toBe(true);
  });
});

describe("verifyInternalBridgeToken (EG-13 AC3, constant-time compare)", () => {
  const config = { token: TOKEN };

  it("accepts a matching Bearer token, case-insensitive scheme", () => {
    expect(verifyInternalBridgeToken(`Bearer ${TOKEN}`, config)).toBe(true);
    expect(verifyInternalBridgeToken(`bearer ${TOKEN}`, config)).toBe(true);
  });

  it("rejects a mismatched token", () => {
    expect(verifyInternalBridgeToken("Bearer wrong-token", config)).toBe(false);
  });

  it("rejects tokens of a different length without throwing", () => {
    expect(verifyInternalBridgeToken(`Bearer ${TOKEN}x`, config)).toBe(false);
    expect(verifyInternalBridgeToken("Bearer short", config)).toBe(false);
  });

  it("rejects a missing or malformed Authorization header", () => {
    expect(verifyInternalBridgeToken(undefined, config)).toBe(false);
    expect(verifyInternalBridgeToken(null, config)).toBe(false);
    expect(verifyInternalBridgeToken("", config)).toBe(false);
    expect(verifyInternalBridgeToken(TOKEN, config)).toBe(false); // missing "Bearer " scheme
    expect(verifyInternalBridgeToken("Basic dXNlcjpwYXNz", config)).toBe(false);
  });

  it("fails closed (returns false, not an error) when the bridge is unconfigured", () => {
    expect(verifyInternalBridgeToken(`Bearer ${TOKEN}`, { env: {} })).toBe(false);
  });

  it("does not distinguish unconfigured vs missing-header vs mismatch in its return shape", () => {
    // GC-07/ER-11: all three fail closed on the exact same `boolean` contract.
    const unconfigured = verifyInternalBridgeToken(`Bearer ${TOKEN}`, { env: {} });
    const missingHeader = verifyInternalBridgeToken(undefined, config);
    const mismatch = verifyInternalBridgeToken("Bearer nope", config);
    expect([unconfigured, missingHeader, mismatch]).toEqual([false, false, false]);
  });
});

describe("createCollabInternalBridge (EG-13)", () => {
  it("skips (does not call fetch) when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const bridge = createCollabInternalBridge({ env: {}, fetchImpl });
    expect(bridge.isConfigured()).toBe(false);
    const result = await bridge.postInternal("/internal/health", {});
    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts with a Bearer authorization header and JSON body when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
    });
    expect(bridge.isConfigured()).toBe(true);

    const result = await bridge.postInternal("/internal/reset", { foo: "bar" });
    expect(result).toEqual({ ok: true, skipped: false, status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${URL}/internal/reset`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
  });

  it("propagates a non-ok status without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 1 },
    });
    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: false, skipped: false, status: 503 });
  });
});

describe("createCollabInternalBridge (EG-13 ER-10 bounded retry)", () => {
  it("retries a transient 503 and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) return new Response(null, { status: 503 });
      return new Response(null, { status: 200 });
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: true, skipped: false, status: 200 });
    expect(calls).toBe(3);
  });

  it("retries a transient 429 and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) return new Response(null, { status: 429 });
      return new Response(null, { status: 200 });
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: true, skipped: false, status: 200 });
    expect(calls).toBe(2);
  });

  it("exhausts the bounded retry budget on a persistent 503 and returns ok:false with the last status, never throwing", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: false, skipped: false, status: 503 });
    expect(calls).toBe(3);
  });

  it("does not retry a deterministic 400 response (ER-10: fails on the first attempt)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      return new Response(null, { status: 400 });
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: false, skipped: false, status: 400 });
    expect(calls).toBe(1);
  });

  it("retries a thrown network error and eventually succeeds, never letting the exception escape", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return new Response(null, { status: 200 });
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: true, skipped: false, status: 200 });
    expect(calls).toBe(3);
  });

  it("retries a thrown abort/timeout error and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response(null, { status: 200 });
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const result = await bridge.postInternal("/internal/reset", {});
    expect(result).toEqual({ ok: true, skipped: false, status: 200 });
    expect(calls).toBe(2);
  });

  it("exhausts the retry budget on a persistent network error and fails closed to ok:false instead of throwing", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(bridge.postInternal("/internal/reset", {})).resolves.toEqual({ ok: false, skipped: false });
    expect(calls).toBe(3);
  });
});

describe("collection append/bump (RT-07)", () => {
  it("posts append and bump paths and skips when unconfigured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const bridge = createCollabInternalBridge({
      internalUrl: URL,
      token: TOKEN,
      fetchImpl,
      retry: { maxAttempts: 1 },
    });
    await expect(
      bridge.appendCollectionChild("collection:channel:chn-1", "msg-1"),
    ).resolves.toEqual({ ok: true, skipped: false, status: 200 });
    await expect(
      bridge.bumpCollectionRevision("collection:channel:chn-1", {
        kind: "edit",
        messageId: "msg-1",
        at: 9,
      }),
    ).resolves.toEqual({ ok: true, skipped: false, status: 200 });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${URL}/internal/collection/append`,
      expect.objectContaining({
        body: JSON.stringify({ roomName: "collection:channel:chn-1", childId: "msg-1" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${URL}/internal/collection/bump`,
      expect.objectContaining({
        body: JSON.stringify({
          roomName: "collection:channel:chn-1",
          kind: "edit",
          messageId: "msg-1",
          at: 9,
        }),
      }),
    );

    const skipped = createCollabInternalBridge({ env: {}, fetchImpl: vi.fn() });
    await expect(skipped.appendCollectionChild("collection:channel:chn-1", "msg-1")).resolves.toEqual({
      ok: false,
      skipped: true,
    });
  });
});
