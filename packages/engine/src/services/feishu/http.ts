// megaui-only (FS-03): the fixed-origin transport has no upstream counterpart.
/**
 * FS-03：固定源 HTTP 传输。
 *
 * The transport consumes the frozen target of FS-87 and never decides the
 * provider again: every request goes to the origin of that target, a
 * redirect is refused instead of followed, and a transport failure cannot
 * reach another source.
 *
 * One operation has a total budget. A transient error is retried inside that
 * budget with an exponential backoff, up to `maxAttempts` HTTP attempts in all
 * (three by default), while a permanent permission error is not retried at
 * all. A caller that decides retries itself (the Feishu login issue service,
 * FSL-149) passes `maxAttempts: 1`, so every `request()` makes exactly one HTTP
 * attempt. The error output names the status and the business code, never a
 * token or a secret.
 *
 * A caller may also pass an absolute `deadline` (milliseconds on the clock of
 * `now`, FSL-160): once it has passed no HTTP attempt is started and the
 * request fails with `transport_deadline`, and every attempt is bounded by
 * `min(budget, deadline - now)`. Without a `deadline` nothing changes.
 */
import type { ProviderTarget } from "@megaui/core";

export type FeishuTransportErrorCode =
  | "transport_permanent"
  | "transport_transient"
  | "transport_redirect"
  | "transport_timeout"
  /** FSL-160: the caller's absolute deadline passed before an HTTP attempt was started. */
  | "transport_deadline";

export class FeishuTransportError extends Error {
  readonly code: FeishuTransportErrorCode;
  /** The HTTP status, when the failure had a response. */
  readonly status: number | undefined;
  /** The business code of the provider, when it answered with one. */
  readonly businessCode: number | undefined;

  constructor(
    code: FeishuTransportErrorCode,
    message: string,
    options: { status?: number; businessCode?: number } = {},
  ) {
    super(message);
    this.name = "FeishuTransportError";
    this.code = code;
    this.status = options.status;
    this.businessCode = options.businessCode;
  }
}

export interface FeishuTransportOptions {
  /** The frozen target of FS-87; it is the only origin this transport reaches. */
  target: ProviderTarget;
  fetchImpl?: typeof fetch;
  /** The total budget of one operation, retries and backoff included. */
  budgetMs?: number;
  /** The base delay of the exponential backoff. */
  backoffMs?: number;
  /**
   * The most HTTP attempts one `request()` makes, the first one included: a
   * positive integer, `FEISHU_MAX_ATTEMPTS` (3) by default. `1` disables the
   * transport retry, so the caller sees the result of every single attempt.
   */
  maxAttempts?: number;
  now?: () => number;
}

/** The default budget of one operation: 20 seconds. */
export const FEISHU_OPERATION_BUDGET_MS = 20_000;
/** The default base delay of the exponential backoff: 250 ms. */
export const FEISHU_BACKOFF_BASE_MS = 250;
/** The default maximum number of attempts of one operation. */
export const FEISHU_MAX_ATTEMPTS = 3;

export interface FeishuRequestInit {
  method?: "GET" | "POST";
  json?: Record<string, unknown>;
  headers?: Record<string, string>;
  /**
   * FSL-160: the absolute deadline of this request, in milliseconds on the clock of the
   * transport's `now` (`Date.now()` by default). Once it has passed no HTTP attempt is
   * started (`transport_deadline`); an attempt's abort timer is set to the time left before it
   * (the abort fires through the event loop, so a blocked loop delays it). Optional: without it the
   * request is bounded by the operation budget only, as before.
   */
  deadline?: number;
}

export class FeishuTransport {
  /** The only origin this transport may reach. */
  readonly origin: string;

  private readonly target: ProviderTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly budgetMs: number;
  private readonly backoffMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: FeishuTransportOptions) {
    const maxAttempts = options.maxAttempts ?? FEISHU_MAX_ATTEMPTS;
    // Fail closed on a value that would silently skip or multiply attempts.
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("INVALID_FEISHU_TRANSPORT_MAX_ATTEMPTS");
    }
    this.target = options.target;
    this.origin = options.target.origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.budgetMs = options.budgetMs ?? FEISHU_OPERATION_BUDGET_MS;
    this.backoffMs = options.backoffMs ?? FEISHU_BACKOFF_BASE_MS;
    this.maxAttempts = maxAttempts;
    this.now = options.now ?? Date.now;
  }

  /**
   * Requests a path of the frozen origin.
   *
   * `path` is relative to the origin: a caller can not name another host,
   * and the redirect mode refuses a response that would move the request.
   */
  async request<T>(path: string, init: FeishuRequestInit = {}): Promise<T> {
    if (!path.startsWith("/") || path.includes("://") || path.startsWith("//")) {
      throw new FeishuTransportError(
        "transport_permanent",
        "the request path must stay relative to the frozen provider origin",
      );
    }
    const callerDeadline = init.deadline;
    if (callerDeadline !== undefined && !Number.isFinite(callerDeadline)) {
      throw new Error("INVALID_FEISHU_TRANSPORT_DEADLINE");
    }
    const startedAt = this.now();
    if (callerDeadline !== undefined && callerDeadline - startedAt <= 0) {
      // FSL-160: nothing leaves the process once the caller's deadline has passed.
      throw new FeishuTransportError(
        "transport_deadline",
        "the request deadline passed before the request was started",
      );
    }
    const url = `${this.origin}${path}`;
    // Every attempt and backoff stays inside min(budget, caller deadline).
    const deadline =
      callerDeadline === undefined
        ? startedAt + this.budgetMs
        : Math.min(startedAt + this.budgetMs, callerDeadline);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const outcome = await this.attempt<T>(url, init, deadline);
        // The deadline (or the budget) had passed when the attempt was about to start.
        if (outcome === NOT_STARTED) break;
        return outcome.value;
      } catch (error) {
        lastError = error;
        if (error instanceof FeishuTransportError && !isRetryable(error)) {
          throw error;
        }
        if (attempt + 1 >= this.maxAttempts) break;
        const delay = Math.min(this.backoffMs * 2 ** attempt, deadline - this.now());
        if (delay <= 0) break;
        await sleep(delay);
      }
    }

    if (lastError instanceof FeishuTransportError) throw lastError;
    if (lastError === undefined && callerDeadline !== undefined && callerDeadline - this.now() <= 0) {
      // No attempt was started: the caller's deadline, not the budget, ended the request.
      throw new FeishuTransportError(
        "transport_deadline",
        "the request deadline passed before the request was started",
      );
    }
    throw new FeishuTransportError(
      "transport_timeout",
      "the operation exceeded its total budget",
    );
  }

  /**
   * One HTTP attempt. Everything the request needs is prepared first; the clock is then read
   * once, as the last step before `fetch` is called in the same synchronous run (no `await` in
   * between): that reading decides whether the attempt may start (`NOT_STARTED` otherwise) and
   * is the attempt's timer (FSL-160).
   */
  private async attempt<T>(
    url: string,
    init: FeishuRequestInit,
    deadline: number,
  ): Promise<{ value: T } | typeof NOT_STARTED> {
    const requestInit: RequestInit = {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      // A manual redirect never moves the request: the 3xx answer is
      // refused below instead of being followed.
      redirect: "manual",
    };
    const remaining = deadline - this.now();
    if (remaining <= 0) return NOT_STARTED;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await this.fetchImpl(url, { ...requestInit, signal: controller.signal });

      if (response.status >= 300 && response.status < 400) {
        throw new FeishuTransportError(
          "transport_redirect",
          `the provider answered with a redirect (${response.status})`,
          { status: response.status },
        );
      }
      if (response.status === 429 || response.status >= 500) {
        throw new FeishuTransportError(
          "transport_transient",
          `the provider answered with ${response.status}`,
          { status: response.status },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new FeishuTransportError(
          "transport_permanent",
          `the provider refused the request (${response.status})`,
          { status: response.status },
        );
      }
      if (!response.ok) {
        throw new FeishuTransportError(
          "transport_permanent",
          `the provider answered with ${response.status}`,
          { status: response.status },
        );
      }

      const body = (await response.json()) as { code?: number; msg?: string } & T;
      if (typeof body.code === "number" && body.code !== 0) {
        // The body is never echoed: a provider error can carry a token.
        throw new FeishuTransportError(
          "transport_permanent",
          `the provider refused the request with business code ${body.code}`,
          { status: response.status, businessCode: body.code },
        );
      }
      return { value: body };
    } catch (error) {
      if (error instanceof FeishuTransportError) throw error;
      if (controller.signal.aborted) {
        throw new FeishuTransportError(
          "transport_timeout",
          "the provider did not answer inside the operation budget",
        );
      }
      throw new FeishuTransportError(
        "transport_transient",
        "the provider could not be reached",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** An attempt that was not started because its deadline or budget had passed. */
const NOT_STARTED = Symbol("not_started");

function isRetryable(error: FeishuTransportError): boolean {
  return error.code === "transport_transient" || error.code === "transport_timeout";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
