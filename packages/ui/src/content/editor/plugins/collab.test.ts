import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundedReconnectScheduler, resolveCollabMode, resolveCollabPublicUrl } from "./collab";

describe("resolveCollabMode (AC2/AC4 fail-closed gating)", () => {
  it("AC4: blank/whitespace url → local mode", () => {
    expect(resolveCollabMode({ url: "   ", token: "tok", documentName: "container:doc:1" })).toBe("local");
  });

  it("AC4: no url → local mode (plain editable, no collab intent)", () => {
    expect(resolveCollabMode(undefined)).toBe("local");
    expect(resolveCollabMode(null)).toBe("local");
    expect(resolveCollabMode({ url: "", token: "tok", documentName: "container:doc:1" })).toBe("local");
  });

  it("AC2: url set but token missing → read-only (fail-closed, never a silent editable fallback)", () => {
    expect(
      resolveCollabMode({ url: "wss://collab.example", token: undefined, documentName: "container:doc:1" }),
    ).toBe("readonly");
    expect(resolveCollabMode({ url: "wss://collab.example", token: null, documentName: "container:doc:1" })).toBe(
      "readonly",
    );
    expect(resolveCollabMode({ url: "wss://collab.example", token: "", documentName: "container:doc:1" })).toBe(
      "readonly",
    );
  });

  it("url + token set but documentName missing → read-only (incomplete room identity is also fail-closed)", () => {
    expect(
      resolveCollabMode({ url: "wss://collab.example", token: "tok", documentName: "" as unknown as string }),
    ).toBe("readonly");
  });

  it("url + token + documentName all present → collab", () => {
    expect(resolveCollabMode({ url: "wss://collab.example", token: "tok", documentName: "container:doc:1" })).toBe(
      "collab",
    );
  });
});

describe("resolveCollabPublicUrl", () => {
  it("returns null for unset/blank env (AC4 local-mode trigger)", () => {
    expect(resolveCollabPublicUrl({})).toBeNull();
    expect(resolveCollabPublicUrl({ NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL: "   " })).toBeNull();
  });

  it("trims and returns a configured url", () => {
    expect(resolveCollabPublicUrl({ NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL: " wss://collab.example  " })).toBe(
      "wss://collab.example",
    );
  });
});

describe("createBoundedReconnectScheduler (AC2: connection failure retry bounded)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules attempts up to maxAttempts and then refuses further scheduling", () => {
    // Mirrors real usage: each `scheduleAttempt` call corresponds to a fresh 'disconnected'
    // event fired only after the previous attempt's connect() has run (and failed again) —
    // not back-to-back calls racing the same pending timer.
    const scheduler = createBoundedReconnectScheduler({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 });
    const connect = vi.fn();

    expect(scheduler.scheduleAttempt(connect)).toBe(true);
    expect(scheduler.attempts).toBe(1);
    expect(scheduler.exhausted).toBe(false);
    vi.runAllTimers();
    expect(connect).toHaveBeenCalledTimes(1);

    expect(scheduler.scheduleAttempt(connect)).toBe(true);
    expect(scheduler.attempts).toBe(2);
    vi.runAllTimers();
    expect(connect).toHaveBeenCalledTimes(2);

    expect(scheduler.scheduleAttempt(connect)).toBe(true);
    expect(scheduler.attempts).toBe(3);
    expect(scheduler.exhausted).toBe(true);
    vi.runAllTimers();
    expect(connect).toHaveBeenCalledTimes(3);

    // Exhausted: no further attempts scheduled, no matter how many times called.
    expect(scheduler.scheduleAttempt(connect)).toBe(false);
    expect(scheduler.scheduleAttempt(connect)).toBe(false);
    expect(scheduler.attempts).toBe(3);
    vi.runAllTimers();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("grows delay exponentially and caps it at maxDelayMs", () => {
    const scheduler = createBoundedReconnectScheduler({ maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 5_000 });
    const connect = vi.fn();

    scheduler.scheduleAttempt(connect); // attempt 0 -> delay 1_000
    vi.advanceTimersByTime(999);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(1);

    scheduler.scheduleAttempt(connect); // attempt 1 -> delay 2_000
    vi.advanceTimersByTime(1_999);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);

    scheduler.scheduleAttempt(connect); // attempt 2 -> would be 4_000, still under cap
    vi.advanceTimersByTime(4_000);
    expect(connect).toHaveBeenCalledTimes(3);

    scheduler.scheduleAttempt(connect); // attempt 3 -> would be 8_000, capped at 5_000
    vi.advanceTimersByTime(5_000);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("reset() zeroes the counter and cancels a pending attempt (call on confirmed sync)", () => {
    const scheduler = createBoundedReconnectScheduler({ maxAttempts: 2, baseDelayMs: 1_000 });
    const connect = vi.fn();

    scheduler.scheduleAttempt(connect);
    expect(scheduler.attempts).toBe(1);
    scheduler.reset();
    expect(scheduler.attempts).toBe(0);
    expect(scheduler.exhausted).toBe(false);

    vi.runAllTimers();
    expect(connect).not.toHaveBeenCalled(); // pending timer was cancelled by reset()

    // Fresh budget after reset.
    expect(scheduler.scheduleAttempt(connect)).toBe(true);
    expect(scheduler.scheduleAttempt(connect)).toBe(true);
    expect(scheduler.scheduleAttempt(connect)).toBe(false);
  });

  it("dispose() cancels a pending attempt without resetting the counter (call on teardown)", () => {
    const scheduler = createBoundedReconnectScheduler({ maxAttempts: 5, baseDelayMs: 1_000 });
    const connect = vi.fn();
    scheduler.scheduleAttempt(connect);
    scheduler.dispose();
    vi.runAllTimers();
    expect(connect).not.toHaveBeenCalled();
    expect(scheduler.attempts).toBe(1);
  });

  it("maxAttempts: 0 means unbounded (never exhausted)", () => {
    const scheduler = createBoundedReconnectScheduler({ maxAttempts: 0, baseDelayMs: 10 });
    for (let i = 0; i < 50; i += 1) {
      expect(scheduler.scheduleAttempt(() => {})).toBe(true);
    }
    expect(scheduler.exhausted).toBe(false);
  });
});

describe("createLexicalHocuspocusProvider disconnect vs destroy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubWebSocket(options?: { openThenCloseMs?: number }) {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      url: string;
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      private listeners = new Map<string, Set<(ev: Event) => void>>();
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          const openEv = new Event("open");
          this.onopen?.(openEv);
          this.listeners.get("open")?.forEach((cb) => cb(openEv));
          if (options?.openThenCloseMs != null) {
            setTimeout(() => this.close(), options.openThenCloseMs);
          }
        });
      }
      send(): void {}
      close(): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        const closeEv = new CloseEvent("close");
        this.onclose?.(closeEv);
        this.listeners.get("close")?.forEach((cb) => cb(closeEv));
      }
      addEventListener(type: string, cb: (ev: Event) => void): void {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
      }
      removeEventListener(type: string, cb: (ev: Event) => void): void {
        this.listeners.get(type)?.delete(cb);
      }
      dispatchEvent(): boolean {
        return false;
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    return sockets;
  }

  it("soft disconnect leaves destroy available for later reconnect semantics", async () => {
    stubWebSocket();
    const { createLexicalHocuspocusProvider } = await import("./collab");
    const Y = await import("yjs");
    const doc = new Y.Doc();
    const provider = createLexicalHocuspocusProvider({
      url: "ws://127.0.0.1:9",
      name: "container:doc:teardown-test",
      document: doc,
      token: "tok",
      enableIndexedDb: false,
      localPersistReady: Promise.resolve(),
      offlineBootstrapMs: 60_000,
      reconnect: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 },
    });

    expect(() => provider.disconnect()).not.toThrow();
    expect(() => provider.connect()).not.toThrow();
    expect(() => provider.destroy()).not.toThrow();
    expect(() => provider.destroy()).not.toThrow();
    doc.destroy();
  });

  it("AC2: caps reconnect attempts after open→close and never reconnects after destroy", async () => {
    vi.useFakeTimers();
    const sockets = stubWebSocket({ openThenCloseMs: 5 });
    const { createLexicalHocuspocusProvider } = await import("./collab");
    const Y = await import("yjs");
    const doc = new Y.Doc();
    const provider = createLexicalHocuspocusProvider({
      url: "ws://127.0.0.1:9",
      name: "container:doc:bounded-reconnect",
      document: doc,
      token: "tok",
      enableIndexedDb: false,
      localPersistReady: Promise.resolve(),
      offlineBootstrapMs: 60_000,
      reconnect: { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 20 },
    });

    provider.connect();
    await vi.advanceTimersByTimeAsync(0); // open microtask
    await vi.advanceTimersByTimeAsync(5); // first close
    // Two scheduled reconnect attempts (20ms each) + their open/close cycles.
    await vi.advanceTimersByTimeAsync(200);
    const afterBounded = sockets.length;
    expect(afterBounded).toBeGreaterThan(1);
    expect(afterBounded).toBeLessThanOrEqual(3); // initial + 2 reconnects

    provider.destroy();
    const atDestroy = sockets.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets.length).toBe(atDestroy); // no post-destroy sockets

    provider.disconnect(); // soft path after destroy must stay inert
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets.length).toBe(atDestroy);
    doc.destroy();
  });
});
