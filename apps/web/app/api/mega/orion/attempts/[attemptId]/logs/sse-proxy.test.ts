import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SSE_PROXY_BOUNDS,
  SseAuthRevokedError,
  SseProxyConfigError,
  createGuardedSseStream,
  parseSseProxyConfig,
  type SseProxyConfig,
  type SseTeardownReason,
} from "./sse-proxy";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function validConfig(overrides: Partial<SseProxyConfig> = {}): SseProxyConfig {
  return {
    recheckIntervalMs: 1_000,
    recheckTimeoutMs: 200,
    teardownTimeoutMs: 100,
    maxDurationMs: 10_000,
    ...overrides,
  };
}

describe("parseSseProxyConfig & createGuardedSseStream (CLB-31)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces fail-closed min/max bounds in parseSseProxyConfig and rejects invalid env values", () => {
    const defaults = parseSseProxyConfig({});
    expect(defaults).toEqual({
      recheckIntervalMs: SSE_PROXY_BOUNDS.recheckIntervalMs.default,
      recheckTimeoutMs: SSE_PROXY_BOUNDS.recheckTimeoutMs.default,
      teardownTimeoutMs: SSE_PROXY_BOUNDS.teardownTimeoutMs.default,
      maxDurationMs: SSE_PROXY_BOUNDS.maxDurationMs.default,
    });

    const minEdge = parseSseProxyConfig({
      ORION2_SSE_RECHECK_INTERVAL_MS: "1000",
      ORION2_SSE_RECHECK_TIMEOUT_MS: "200",
      ORION2_SSE_TEARDOWN_TIMEOUT_MS: "100",
      ORION2_SSE_MAX_DURATION_MS: "10000",
    });
    expect(minEdge.recheckIntervalMs).toBe(1_000);
    expect(minEdge.recheckTimeoutMs).toBe(200);
    expect(minEdge.teardownTimeoutMs).toBe(100);
    expect(minEdge.maxDurationMs).toBe(10_000);

    const invalidEnvs: Array<Record<string, string>> = [
      { ORION2_SSE_RECHECK_INTERVAL_MS: "999" },
      { ORION2_SSE_RECHECK_INTERVAL_MS: "15001" },
      { ORION2_SSE_RECHECK_INTERVAL_MS: "1000.5" },
      { ORION2_SSE_RECHECK_INTERVAL_MS: "abc" },
      { ORION2_SSE_RECHECK_TIMEOUT_MS: "199" },
      { ORION2_SSE_RECHECK_TIMEOUT_MS: "2001" },
      { ORION2_SSE_TEARDOWN_TIMEOUT_MS: "99" },
      { ORION2_SSE_TEARDOWN_TIMEOUT_MS: "1001" },
      { ORION2_SSE_MAX_DURATION_MS: "9999" },
      { ORION2_SSE_MAX_DURATION_MS: "600001" },
      { ORION2_SSE_MAX_DURATION_MS: "" },
    ];
    for (const badEnv of invalidEnvs) {
      expect(() => parseSseProxyConfig(badEnv)).toThrow(SseProxyConfigError);
    }

    // Direct call with out-of-bounds config also fails closed
    const abort = new AbortController();
    const upstream = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    expect(() =>
      createGuardedSseStream({
        upstreamBody: upstream,
        upstreamAbort: abort,
        recheckAuth: async () => true,
        config: validConfig({ recheckIntervalMs: 99_999 }),
      }),
    ).toThrow(SseProxyConfigError);
  });

  it("streams upstream chunks incrementally without full-log buffering and cleans up on EOF", async () => {
    vi.useFakeTimers();
    const upstreamAbort = new AbortController();
    const reasons: SseTeardownReason[] = [];
    let pulls = 0;
    const chunks = ["id: 1\ndata: line-1\n\n", "id: 2\ndata: line-2\n\n"];

    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulls++];
        if (next !== undefined) {
          controller.enqueue(encoder.encode(next));
        } else {
          controller.close();
        }
      },
    });

    const guarded = createGuardedSseStream({
      upstreamBody,
      upstreamAbort,
      recheckAuth: async () => true,
      config: validConfig(),
      onTeardown: (r) => reasons.push(r),
    });

    const reader = guarded.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("id: 1\ndata: line-1\n\n");

    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe("id: 2\ndata: line-2\n\n");

    const eof = await reader.read();
    expect(eof.done).toBe(true);
    expect(reasons).toEqual(["upstream_eof"]);
    expect(upstreamAbort.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("revokes and aborts upstream even when downstream client is stalled (backpressure-decoupled)", async () => {
    vi.useFakeTimers();
    const upstreamAbort = new AbortController();
    const reasons: SseTeardownReason[] = [];
    let upstreamCancelled = false;
    let recheckCount = 0;

    // Infinite upstream that fills the single-chunk buffer; downstream NEVER reads!
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: buffered-chunk\n\n"));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });

    const guarded = createGuardedSseStream({
      upstreamBody,
      upstreamAbort,
      recheckAuth: async () => {
        recheckCount += 1;
        return recheckCount < 2; // 1st check passes, 2nd check revokes!
      },
      config: validConfig({ recheckIntervalMs: 1_000, recheckTimeoutMs: 200, teardownTimeoutMs: 100 }),
      onTeardown: (r) => reasons.push(r),
    });

    // Downstream client is completely stalled: do NOT call reader.read() yet!
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recheckCount).toBe(1);
    expect(upstreamAbort.signal.aborted).toBe(false);

    // Second interval revokes access despite stalled downstream client!
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recheckCount).toBe(2);
    expect(upstreamAbort.signal.aborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
    expect(reasons).toEqual(["auth_revoked"]);

    // Subsequent read on downstream observes the revocation error
    const reader = guarded.getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(SseAuthRevokedError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed within recheckTimeoutMs + teardownTimeoutMs when recheckAuth hangs or throws", async () => {
    vi.useFakeTimers();
    const upstreamAbort = new AbortController();
    const reasons: SseTeardownReason[] = [];
    let recheckSignalAborted = false;

    const upstreamBody = new ReadableStream<Uint8Array>({
      start() {
        // Stays open forever until cancelled
      },
    });

    const guarded = createGuardedSseStream({
      upstreamBody,
      upstreamAbort,
      recheckAuth: (signal) =>
        new Promise<boolean>(() => {
          signal.addEventListener("abort", () => {
            recheckSignalAborted = true;
          });
          // Never resolves (simulates hung DB / mega2)
        }),
      config: validConfig({ recheckIntervalMs: 1_000, recheckTimeoutMs: 300, teardownTimeoutMs: 100 }),
      onTeardown: (r) => reasons.push(r),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(upstreamAbort.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    expect(recheckSignalAborted).toBe(true);
    expect(upstreamAbort.signal.aborted).toBe(true);
    expect(reasons).toEqual(["auth_timeout"]);

    const reader = guarded.getReader();
    await expect(reader.read()).rejects.toThrow("auth_timeout");
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);

    // Throwing recheckAuth also fails closed with auth_error
    const abortErr = new AbortController();
    const errReasons: SseTeardownReason[] = [];
    const guardedErr = createGuardedSseStream({
      upstreamBody: new ReadableStream<Uint8Array>({ start() {} }),
      upstreamAbort: abortErr,
      recheckAuth: async () => {
        throw new Error("db_down");
      },
      config: validConfig({ recheckIntervalMs: 1_000, recheckTimeoutMs: 300, teardownTimeoutMs: 100 }),
      onTeardown: (r) => errReasons.push(r),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(abortErr.signal.aborted).toBe(true);
    expect(errReasons).toEqual(["auth_error"]);
    await expect(guardedErr.getReader().read()).rejects.toThrow("auth_error");
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes retry: 1000\\n\\n and closes cleanly at maxDurationMs, and cleans up on client cancel", async () => {
    vi.useFakeTimers();

    // Case 1: maxDurationMs
    const abort1 = new AbortController();
    const reasons1: SseTeardownReason[] = [];
    const upstream1 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: hello\n\n"));
      },
    });
    const guarded1 = createGuardedSseStream({
      upstreamBody: upstream1,
      upstreamAbort: abort1,
      recheckAuth: async () => true,
      config: validConfig({ recheckIntervalMs: 5_000, maxDurationMs: 10_000 }),
      onTeardown: (r) => reasons1.push(r),
    });

    const reader1 = guarded1.getReader();
    const first = await reader1.read();
    expect(decoder.decode(first.value)).toBe("data: hello\n\n");

    const nextReadPromise = reader1.read();
    await vi.advanceTimersByTimeAsync(10_000);
    const retryChunk = await nextReadPromise;
    expect(retryChunk.done).toBe(false);
    expect(decoder.decode(retryChunk.value)).toBe("retry: 1000\n\n");

    const doneChunk = await reader1.read();
    expect(doneChunk.done).toBe(true);
    expect(abort1.signal.aborted).toBe(true);
    expect(reasons1).toEqual(["max_duration"]);

    // Case 1b: maxDurationMs after an unterminated upstream line prefixes '\n' so 'retry: 1000' begins on a fresh SSE line
    const abortPartial = new AbortController();
    const upstreamPartial = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: partial"));
      },
    });
    const guardedPartial = createGuardedSseStream({
      upstreamBody: upstreamPartial,
      upstreamAbort: abortPartial,
      recheckAuth: async () => true,
      config: validConfig({ recheckIntervalMs: 5_000, maxDurationMs: 10_000 }),
    });
    const readerPartial = guardedPartial.getReader();
    expect(decoder.decode((await readerPartial.read()).value)).toBe("data: partial");
    const partialRetryPromise = readerPartial.read();
    await vi.advanceTimersByTimeAsync(10_000);
    const partialRetryChunk = await partialRetryPromise;
    expect(partialRetryChunk.done).toBe(false);
    expect(decoder.decode(partialRetryChunk.value)).toBe("\nretry: 1000\n\n");
    expect((await readerPartial.read()).done).toBe(true);

    // Case 2: client cancel cleans up timers & aborts upstream
    const abort2 = new AbortController();
    const reasons2: SseTeardownReason[] = [];
    let cancelled2 = false;
    const upstream2 = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled2 = true;
      },
    });
    const guarded2 = createGuardedSseStream({
      upstreamBody: upstream2,
      upstreamAbort: abort2,
      recheckAuth: async () => true,
      config: validConfig(),
      onTeardown: (r) => reasons2.push(r),
    });

    await guarded2.cancel("client_closed");
    expect(abort2.signal.aborted).toBe(true);
    expect(cancelled2).toBe(true);
    expect(reasons2).toEqual(["client_cancel"]);
    expect(vi.getTimerCount()).toBe(0);

    // Case 3: hung upstream cancel is bounded by teardownTimeoutMs for BOTH guarded.cancel() AND clientSignal abort
    const abort3 = new AbortController();
    const reasons3: SseTeardownReason[] = [];
    const hungUpstreamCancel = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(() => {
          // Never resolves
        });
      },
    });
    const guarded3 = createGuardedSseStream({
      upstreamBody: hungUpstreamCancel,
      upstreamAbort: abort3,
      recheckAuth: async () => true,
      config: validConfig({ teardownTimeoutMs: 150 }),
      onTeardown: (r) => reasons3.push(r),
    });
    let cancelSettled = false;
    const cancelPromise = guarded3.cancel("client_closed").then(() => {
      cancelSettled = true;
    });
    expect(abort3.signal.aborted).toBe(true);
    expect(reasons3).toEqual(["client_cancel"]);
    await vi.advanceTimersByTimeAsync(149);
    expect(cancelSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cancelPromise;
    expect(cancelSettled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const abort4 = new AbortController();
    const clientAbort = new AbortController();
    const reasons4: SseTeardownReason[] = [];
    const hungUpstreamSignal = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(() => {
          // Never resolves
        });
      },
    });
    const guarded4 = createGuardedSseStream({
      upstreamBody: hungUpstreamSignal,
      upstreamAbort: abort4,
      recheckAuth: async () => true,
      config: validConfig({ teardownTimeoutMs: 150 }),
      clientSignal: clientAbort.signal,
      onTeardown: (r) => reasons4.push(r),
    });
    clientAbort.abort();
    expect(abort4.signal.aborted).toBe(true);
    expect(reasons4).toEqual(["client_cancel"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.getTimerCount()).toBe(0);
    expect((await guarded4.getReader().read()).done).toBe(true);
  });
});
