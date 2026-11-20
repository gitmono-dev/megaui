// megaui-only (FSL-146): the cleanup scheduler with fake timers and a scripted pool.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  FEISHU_LOGIN_CLEANUP_FAILED,
  FEISHU_LOGIN_CLEANUP_INTERVAL_MS,
  startFeishuLoginCleanup,
  type FeishuLoginCleanupLogKey,
} from "./cleanup";

/** A database error that quotes a row, as a CHECK violation would. */
const SENSITIVE = "Failing row contains (alice@example.com, ou_mock_alice)";

type Outcome = "ok" | "fail" | "hang";

/**
 * A pool whose cleanup statement follows a script of outcomes (then succeeds). `query` records
 * the cleanup statements only (one per run); the transaction statements around it always
 * succeed, and every connection is released.
 */
function scriptedPool(outcomes: Outcome[] = []) {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const connections = { open: 0 };
  const query = vi.fn(async (text: string) => {
    calls.push(text);
    const outcome = outcomes.shift() ?? "ok";
    if (outcome === "fail") throw new Error(SENSITIVE);
    if (outcome === "hang") await new Promise<void>((resolve) => pending.push(resolve));
    return { rows: [{ voided: 0, deleted: 0 }] };
  });
  const client = {
    async query(text: string) {
      if (text.includes("feishu_login_codes")) return query(text);
      return { rows: [] };
    },
    release() {
      connections.open -= 1;
    },
  };
  const pool = {
    async connect() {
      connections.open += 1;
      return client;
    },
  } as unknown as Pool;
  return { pool, query, calls, connections, release: () => pending.splice(0).forEach((done) => done()) };
}

describe("startFeishuLoginCleanup (FSL-146)", () => {
  let logs: FeishuLoginCleanupLogKey[];
  const log = (key: FeishuLoginCleanupLogKey) => {
    logs.push(key);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs every five minutes", () => {
    expect(FEISHU_LOGIN_CLEANUP_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("AC5: runs the cleanup once at start, before the start resolves", async () => {
    const { pool, query, calls } = scriptedPool();
    const stop = await startFeishuLoginCleanup(pool, { log });
    expect(query).toHaveBeenCalledTimes(1);
    expect(calls[0]).toContain("feishu_login_codes");
    expect(typeof stop).toBe("function");
    expect(logs).toEqual([]);
    stop();
  });

  it("AC6: runs the cleanup again every five minutes after the start", async () => {
    const { pool, query } = scriptedPool();
    const stop = await startFeishuLoginCleanup(pool, { log });
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3 * FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(6);
    expect(logs).toEqual([]);
    stop();
  });

  it("the stop function clears the timer: no run follows, and stopping twice is harmless", async () => {
    const { pool, query } = scriptedPool();
    const stop = await startFeishuLoginCleanup(pool, { log });
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(2);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not keep the process alive: the interval timer is unref()ed", async () => {
    const real = globalThis.setInterval;
    const unref = vi.fn();
    const created = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms: number) => {
      const timer = real(handler, ms) as unknown as { unref?: () => unknown };
      const original = timer.unref?.bind(timer);
      timer.unref = () => {
        unref();
        return original?.();
      };
      return timer;
    }) as unknown as typeof setInterval);
    const { pool } = scriptedPool();
    const stop = await startFeishuLoginCleanup(pool, { log });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0]?.[1]).toBe(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
    stop();
  });

  it("AC7: a failed run logs FEISHU_LOGIN_CLEANUP_FAILED and the next period retries successfully", async () => {
    const { pool, query, connections } = scriptedPool(["ok", "fail"]);
    const stop = await startFeishuLoginCleanup(pool, { log });
    expect(logs).toEqual([]);

    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([FEISHU_LOGIN_CLEANUP_FAILED]);
    // The failed run rolled back and released its connection.
    expect(connections.open).toBe(0);

    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(3);
    await expect(query.mock.results[2]!.value).resolves.toEqual({ rows: [{ voided: 0, deleted: 0 }] });
    expect(logs).toEqual([FEISHU_LOGIN_CLEANUP_FAILED]);
    stop();
  });

  it("AC7: a failed first run still resolves the start, and the next period retries successfully", async () => {
    const { pool, query } = scriptedPool(["fail", "fail"]);
    const stop = await startFeishuLoginCleanup(pool, { log });
    expect(query).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([FEISHU_LOGIN_CLEANUP_FAILED]);

    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(logs).toEqual([FEISHU_LOGIN_CLEANUP_FAILED, FEISHU_LOGIN_CLEANUP_FAILED]);
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(3);
    await expect(query.mock.results[2]!.value).resolves.toEqual({ rows: [{ voided: 0, deleted: 0 }] });
    expect(logs).toHaveLength(2);
    stop();
  });

  it("logs only the stable key by default, never the error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plain = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { pool } = scriptedPool(["fail"]);
    const stop = await startFeishuLoginCleanup(pool);
    expect(error.mock.calls).toEqual([[FEISHU_LOGIN_CLEANUP_FAILED]]);
    for (const spy of [info, warn, plain]) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("alice");
    stop();
  });

  it("a throwing logger does not stop the schedule", async () => {
    const { pool, query } = scriptedPool(["fail", "fail"]);
    const stop = await startFeishuLoginCleanup(pool, {
      log: () => {
        throw new Error("logger down");
      },
    });
    await vi.advanceTimersByTimeAsync(2 * FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(3);
    stop();
  });

  it("never overlaps runs: periods during a slow run start exactly one run right after it", async () => {
    const { pool, query, release } = scriptedPool(["ok", "hang"]);
    const stop = await startFeishuLoginCleanup(pool, { log });
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(2);
    // Two periods pass while the second run hangs: no overlapping run starts.
    await vi.advanceTimersByTimeAsync(2 * FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(2);

    // The hanging run ends: the missed periods start one run at once, without waiting for the
    // next period.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS - 1);
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(4);
    expect(logs).toEqual([]);
    stop();
  });
  it("counts the period from the start: a slow first run does not push the schedule back", async () => {
    const { pool, query, release } = scriptedPool(["hang"]);
    let resolved = false;
    const started = startFeishuLoginCleanup(pool, { log }).then((stop) => {
      resolved = true;
      return stop;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    // The first run is still going when the first period comes: no overlapping run starts.
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS + 1000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    // It ends: the start resolves and the missed period runs at once.
    release();
    const stop = await started;
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(2);
    // The next period is still 10 minutes after the start, not 5 minutes after the first run.
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS - 1000 - 1);
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([]);
    stop();
  });

  it("resolves after the first run even when every run outlasts the period and catch-up runs never stop", async () => {
    // Every run hangs longer than one period: the first run, then one catch-up run after another.
    const { pool, query, release } = scriptedPool(["hang", "hang", "hang", "hang"]);
    let resolved = false;
    const started = startFeishuLoginCleanup(pool, { log }).then((stop) => {
      resolved = true;
      return stop;
    });
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS + 1000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);
    // The first run ends while a period is pending: a catch-up run starts at once and hangs, yet
    // the start resolves without waiting for it.
    release();
    const stop = await started;
    expect(resolved).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(2);
    // A further period during the catch-up run starts another one after it, and the start stays resolved.
    await vi.advanceTimersByTimeAsync(FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(3);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toEqual([]);
  });
});
