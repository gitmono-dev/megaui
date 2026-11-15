// megaui-only (FS-03): the fixed-origin transport has no upstream counterpart.
/**
 * FS-03：固定源 HTTP 传输。
 *
 * The transport consumes the frozen target of FS-87 and never decides the
 * provider again: every request goes to the origin of that target, a
 * redirect is refused instead of followed, and a transport failure cannot
 * reach another source.
 *
 * One operation has a total budget. A transient error is retried at most
 * three times inside that budget with an exponential backoff, while a
 * permanent permission error is not retried at all. The error output names
 * the status and the business code, never a token or a secret.
 */
import type { ProviderTarget } from "@megaui/core";

export type FeishuTransportErrorCode =
  | "transport_permanent"
  | "transport_transient"
  | "transport_redirect"
  | "transport_timeout";

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
  now?: () => number;
}

/** The default budget of one operation: 20 seconds. */
export const FEISHU_OPERATION_BUDGET_MS = 20_000;
/** The default base delay of the exponential backoff: 250 ms. */
export const FEISHU_BACKOFF_BASE_MS = 250;
/** The maximum number of attempts of one operation. */
export const FEISHU_MAX_ATTEMPTS = 3;

export interface FeishuRequestInit {
  method?: "GET" | "POST";
  json?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class FeishuTransport {
  /** The only origin this transport may reach. */
  readonly origin: string;

  private readonly target: ProviderTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly budgetMs: number;
  private readonly backoffMs: number;
  private readonly now: () => number;

  constructor(options: FeishuTransportOptions) {
    this.target = options.target;
    this.origin = options.target.origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.budgetMs = options.budgetMs ?? FEISHU_OPERATION_BUDGET_MS;
    this.backoffMs = options.backoffMs ?? FEISHU_BACKOFF_BASE_MS;
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
    const url = `${this.origin}${path}`;
    const deadline = this.now() + this.budgetMs;
    let lastError: unknown;

    for (let attempt = 0; attempt < FEISHU_MAX_ATTEMPTS; attempt += 1) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      try {
        return await this.attempt<T>(url, init, deadline);
      } catch (error) {
        lastError = error;
        if (error instanceof FeishuTransportError && !isRetryable(error)) {
          throw error;
        }
        if (attempt + 1 >= FEISHU_MAX_ATTEMPTS) break;
        const delay = Math.min(this.backoffMs * 2 ** attempt, deadline - this.now());
        if (delay <= 0) break;
        await sleep(delay);
      }
    }

    if (lastError instanceof FeishuTransportError) throw lastError;
    throw new FeishuTransportError(
      "transport_timeout",
      "the operation exceeded its total budget",
    );
  }

  private async attempt<T>(
    url: string,
    init: FeishuRequestInit,
    deadline: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - this.now()));
    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...init.headers,
        },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        // A manual redirect never moves the request: the 3xx answer is
        // refused below instead of being followed.
        redirect: "manual",
        signal: controller.signal,
      });

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
      return body;
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

function isRetryable(error: FeishuTransportError): boolean {
  return error.code === "transport_transient" || error.code === "transport_timeout";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
