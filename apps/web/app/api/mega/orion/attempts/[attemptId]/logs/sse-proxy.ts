/**
 * Backpressure-decoupled guarded SSE proxy engine (`CLB-31` / `ADR-CLB-05`):
 * - Strictly bounds recheck interval, recheck timeout, teardown timeout, and max duration
 *   so worst-case revocation delay is provably `<= 15s + 2s + 1s = 18s`.
 * - Forwards upstream bytes chunk-by-chunk via pull-driven `ReadableStream` (zero full-log
 *   buffering, `GC-10`).
 * - Runs periodic `recheckAuth` on a timer decoupled from downstream `pull()` backpressure,
 *   so even a stalled downstream client cannot delay revocation or prolong an upstream stream.
 * - Immediately aborts upstream and closes/errors downstream within `teardownTimeoutMs` on
 *   any auth denial, error, or timeout; emits `retry: 1000\n\n` and closes cleanly at `maxDurationMs`.
 */

export const SSE_PROXY_BOUNDS = Object.freeze({
  recheckIntervalMs: Object.freeze({ min: 1_000, max: 15_000, default: 15_000 }),
  recheckTimeoutMs: Object.freeze({ min: 200, max: 2_000, default: 2_000 }),
  teardownTimeoutMs: Object.freeze({ min: 100, max: 1_000, default: 1_000 }),
  maxDurationMs: Object.freeze({ min: 10_000, max: 600_000, default: 600_000 }),
});

export interface SseProxyConfig {
  readonly recheckIntervalMs: number;
  readonly recheckTimeoutMs: number;
  readonly teardownTimeoutMs: number;
  readonly maxDurationMs: number;
}

export class SseProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseProxyConfigError";
  }
}

export class SseAuthRevokedError extends Error {
  readonly reason: "auth_revoked" | "auth_timeout" | "auth_error";

  constructor(reason: "auth_revoked" | "auth_timeout" | "auth_error") {
    super(`SSE stream terminated: ${reason}`);
    this.name = "SseAuthRevokedError";
    this.reason = reason;
  }
}

export type SseTeardownReason =
  | "auth_revoked"
  | "auth_timeout"
  | "auth_error"
  | "max_duration"
  | "client_cancel"
  | "upstream_eof"
  | "upstream_error";

export interface GuardedSseStreamOptions {
  readonly upstreamBody: ReadableStream<Uint8Array>;
  readonly upstreamAbort: AbortController;
  readonly recheckAuth: (signal: AbortSignal) => Promise<boolean>;
  readonly config: SseProxyConfig;
  readonly clientSignal?: AbortSignal;
  readonly onTeardown?: (reason: SseTeardownReason) => void;
}

const STRICT_UINT_RE = /^\d+$/;
const RETRY_FRAME = new TextEncoder().encode("retry: 1000\n\n");
const RETRY_FRAME_NEWLINE_PREFIXED = new TextEncoder().encode("\nretry: 1000\n\n");

function parseBoundedMs(
  env: Readonly<Record<string, string | undefined>>,
  envKey: string,
  bounds: { readonly min: number; readonly max: number; readonly default: number },
): number {
  const raw = env[envKey];
  if (raw === undefined) {
    return bounds.default;
  }
  const trimmed = raw.trim();
  if (!trimmed || !STRICT_UINT_RE.test(trimmed)) {
    throw new SseProxyConfigError(
      `${envKey} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new SseProxyConfigError(
      `${envKey} must be between ${bounds.min} and ${bounds.max} (got ${trimmed})`,
    );
  }
  return value;
}

function assertBoundedNumber(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): number {
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new SseProxyConfigError(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  }
  return value;
}

export function validateSseProxyConfig(config: SseProxyConfig): SseProxyConfig {
  return Object.freeze({
    recheckIntervalMs: assertBoundedNumber(
      "recheckIntervalMs",
      config.recheckIntervalMs,
      SSE_PROXY_BOUNDS.recheckIntervalMs,
    ),
    recheckTimeoutMs: assertBoundedNumber(
      "recheckTimeoutMs",
      config.recheckTimeoutMs,
      SSE_PROXY_BOUNDS.recheckTimeoutMs,
    ),
    teardownTimeoutMs: assertBoundedNumber(
      "teardownTimeoutMs",
      config.teardownTimeoutMs,
      SSE_PROXY_BOUNDS.teardownTimeoutMs,
    ),
    maxDurationMs: assertBoundedNumber(
      "maxDurationMs",
      config.maxDurationMs,
      SSE_PROXY_BOUNDS.maxDurationMs,
    ),
  });
}

export function parseSseProxyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SseProxyConfig {
  return validateSseProxyConfig({
    recheckIntervalMs: parseBoundedMs(
      env,
      "ORION2_SSE_RECHECK_INTERVAL_MS",
      SSE_PROXY_BOUNDS.recheckIntervalMs,
    ),
    recheckTimeoutMs: parseBoundedMs(
      env,
      "ORION2_SSE_RECHECK_TIMEOUT_MS",
      SSE_PROXY_BOUNDS.recheckTimeoutMs,
    ),
    teardownTimeoutMs: parseBoundedMs(
      env,
      "ORION2_SSE_TEARDOWN_TIMEOUT_MS",
      SSE_PROXY_BOUNDS.teardownTimeoutMs,
    ),
    maxDurationMs: parseBoundedMs(
      env,
      "ORION2_SSE_MAX_DURATION_MS",
      SSE_PROXY_BOUNDS.maxDurationMs,
    ),
  });
}

/**
 * Creates a pull-driven, backpressure-decoupled guarded SSE `ReadableStream`.
 */
export function createGuardedSseStream(
  options: GuardedSseStreamOptions,
): ReadableStream<Uint8Array> {
  const config = validateSseProxyConfig(options.config);
  const { upstreamBody, upstreamAbort, recheckAuth, clientSignal, onTeardown } = options;

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = upstreamBody.getReader();
  } catch (error) {
    upstreamAbort.abort(error);
    throw error;
  }

  let closed = false;
  let recheckInFlight = false;
  let lastForwardedByte: number | undefined;
  let recheckIntervalTimer: ReturnType<typeof setInterval> | undefined;
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRecheckTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRecheckAbort: AbortController | undefined;
  let teardownTimer: ReturnType<typeof setTimeout> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const clearAllTimers = () => {
    if (recheckIntervalTimer !== undefined) {
      clearInterval(recheckIntervalTimer);
      recheckIntervalTimer = undefined;
    }
    if (maxDurationTimer !== undefined) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = undefined;
    }
    if (activeRecheckTimeoutTimer !== undefined) {
      clearTimeout(activeRecheckTimeoutTimer);
      activeRecheckTimeoutTimer = undefined;
    }
    if (activeRecheckAbort) {
      activeRecheckAbort.abort();
      activeRecheckAbort = undefined;
    }
    if (clientSignal) {
      clientSignal.removeEventListener("abort", handleClientAbort);
    }
  };

  const cancelUpstreamBounded = (reason: string): Promise<void> => {
    if (!upstreamAbort.signal.aborted) {
      upstreamAbort.abort(new Error(reason));
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (teardownTimer !== undefined) {
          clearTimeout(teardownTimer);
          teardownTimer = undefined;
        }
        resolve();
      };
      teardownTimer = setTimeout(() => {
        try {
          reader.releaseLock();
        } catch {
          // Ignore if reader still has a pending read or is already released.
        }
        done();
      }, config.teardownTimeoutMs);

      void reader
        .cancel(reason)
        .catch(() => {
          // Ignore upstream cancel errors during teardown.
        })
        .finally(done);
    });
  };

  let teardownPromise: Promise<void> = Promise.resolve();

  const finalize = (
    reason: SseTeardownReason,
    action: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
    options?: { readonly cancelUpstream?: boolean },
  ): Promise<void> => {
    if (closed) return teardownPromise;
    closed = true;
    clearAllTimers();
    if (options?.cancelUpstream !== false) {
      teardownPromise = cancelUpstreamBounded(reason);
    }
    if (streamController) {
      try {
        action(streamController);
      } catch {
        // Controller may already be closed or errored.
      }
    }
    onTeardown?.(reason);
    return teardownPromise;
  };

  const handleClientAbort = () => {
    finalize("client_cancel", (controller) => {
      controller.close();
    });
  };

  const runAuthRecheck = () => {
    if (closed || recheckInFlight) return;
    recheckInFlight = true;

    const checkAbort = new AbortController();
    activeRecheckAbort = checkAbort;
    let settled = false;

    activeRecheckTimeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      recheckInFlight = false;
      activeRecheckTimeoutTimer = undefined;
      activeRecheckAbort = undefined;
      checkAbort.abort(new Error("recheck_timeout"));
      finalize("auth_timeout", (controller) => {
        controller.error(new SseAuthRevokedError("auth_timeout"));
      });
    }, config.recheckTimeoutMs);

    Promise.resolve()
      .then(() => recheckAuth(checkAbort.signal))
      .then(
        (allowed) => {
          if (settled) return;
          settled = true;
          recheckInFlight = false;
          if (activeRecheckTimeoutTimer !== undefined) {
            clearTimeout(activeRecheckTimeoutTimer);
            activeRecheckTimeoutTimer = undefined;
          }
          activeRecheckAbort = undefined;
          if (closed) return;
          if (allowed !== true) {
            finalize("auth_revoked", (controller) => {
              controller.error(new SseAuthRevokedError("auth_revoked"));
            });
          }
        },
        () => {
          if (settled) return;
          settled = true;
          recheckInFlight = false;
          if (activeRecheckTimeoutTimer !== undefined) {
            clearTimeout(activeRecheckTimeoutTimer);
            activeRecheckTimeoutTimer = undefined;
          }
          activeRecheckAbort = undefined;
          if (closed) return;
          finalize("auth_error", (controller) => {
            controller.error(new SseAuthRevokedError("auth_error"));
          });
        },
      );
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;

        if (clientSignal?.aborted) {
          handleClientAbort();
          return;
        }
        if (clientSignal) {
          clientSignal.addEventListener("abort", handleClientAbort, { once: true });
        }

        // Backpressure-decoupled timers: always run regardless of whether downstream pulls.
        recheckIntervalTimer = setInterval(runAuthRecheck, config.recheckIntervalMs);
        maxDurationTimer = setTimeout(() => {
          finalize("max_duration", (ctrl) => {
            const needsNewline =
              lastForwardedByte !== undefined &&
              lastForwardedByte !== 0x0a &&
              lastForwardedByte !== 0x0d;
            ctrl.enqueue(needsNewline ? RETRY_FRAME_NEWLINE_PREFIXED : RETRY_FRAME);
            ctrl.close();
          });
        }, config.maxDurationMs);
      },

      async pull(controller) {
        while (!closed) {
          try {
            const { done, value } = await reader.read();
            if (closed) return;
            if (done) {
              finalize(
                "upstream_eof",
                (ctrl) => {
                  ctrl.close();
                },
                { cancelUpstream: false },
              );
              return;
            }
            if (value && value.byteLength > 0) {
              lastForwardedByte = value[value.byteLength - 1];
              controller.enqueue(value);
              return;
            }
          } catch (error) {
            if (closed) return;
            finalize("upstream_error", (ctrl) => {
              ctrl.error(error);
            });
            return;
          }
        }
      },

      cancel() {
        return finalize("client_cancel", () => {
          // Stream is already cancelled by consumer.
        });
      },
    },
    { highWaterMark: 1 },
  );
}
