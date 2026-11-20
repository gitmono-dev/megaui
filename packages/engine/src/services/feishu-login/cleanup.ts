// megaui-only (FSL-146): the scheduler of the Feishu login code cleanup.
//
// ADR-FSL-11 "本地数据与清理": every Web process runs the cleanup of `feishu_login_codes`
// (`cleanupFeishuLoginCodes` of `@megaui/database`: expired `reserved` / `active` rows turn `void`
// with their sensitive fields cleared, rows created more than 24 hours ago are deleted) once at
// start and then every 5 minutes. Instances run it on their own; the cleanup is idempotent.
// A failed run logs `FEISHU_LOGIN_CLEANUP_FAILED` and the next period simply runs again.
//
// The Web wiring (FSL-150) awaits `startFeishuLoginCleanup` in `instrumentation.ts`
// `register()`, so the first run has finished before any request is handled.
import type { Pool } from "pg";
import { cleanupFeishuLoginCodes } from "@megaui/database";

/** The period between two cleanup runs. */
export const FEISHU_LOGIN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** The stable log key of a failed cleanup run. */
export const FEISHU_LOGIN_CLEANUP_FAILED = "FEISHU_LOGIN_CLEANUP_FAILED";
export type FeishuLoginCleanupLogKey = typeof FEISHU_LOGIN_CLEANUP_FAILED;

export interface FeishuLoginCleanupSchedulerOptions {
  /**
   * Receives the stable log key only, never the error: a database error may quote a row and so
   * an email, an open_id or a name. Defaults to `console.error`.
   */
  readonly log?: (key: FeishuLoginCleanupLogKey) => void;
}

/** Stops the periodic cleanup; calling it again does nothing. */
export type StopFeishuLoginCleanup = () => void;

/**
 * Runs the cleanup once at start and every `FEISHU_LOGIN_CLEANUP_INTERVAL_MS` from the start, and
 * resolves with the stop function once the first run has finished (successfully or not: a failure is logged and
 * retried by the next period, it never rejects the start). It never waits for the catch-up runs that
 * follow the first one.
 *
 * The timer is `unref()`ed, so it never keeps the process alive, and no signal handler is
 * installed. Runs never overlap within one process: a period that comes while a run is still in
 * progress is not dropped but starts one more run as soon as that run ends (several such
 * periods start a single one), so a slow run delays the next one without losing it.
 */
export async function startFeishuLoginCleanup(
  pool: Pool,
  options: FeishuLoginCleanupSchedulerOptions = {},
): Promise<StopFeishuLoginCleanup> {
  const log = options.log ?? ((key: FeishuLoginCleanupLogKey) => console.error(key));
  let running = false;
  let again = false;
  let stopped = false;
  // The start waits for the first cleanup run only, never for the catch-up runs that may follow
  // it: if every run outlasts the period, the catch-up loop never ends, and the start must not
  // wait for it.
  let firstRunDone!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    firstRunDone = resolve;
  });

  const once = async (): Promise<void> => {
    try {
      await cleanupFeishuLoginCodes(pool);
    } catch {
      try {
        log(FEISHU_LOGIN_CLEANUP_FAILED);
      } catch {
        // A failing logger never stops the schedule.
      }
    }
  };

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await once();
        firstRunDone();
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };

  // The period counts from the start, not from the end of the first run: a slow first run
  // delays nothing but itself (a period that comes during it starts one run right after it).
  const timer = setInterval(() => {
    if (!stopped) void run();
  }, FEISHU_LOGIN_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  void run();
  await firstRun;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
