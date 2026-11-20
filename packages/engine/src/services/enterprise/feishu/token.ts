// megaui-only (FS-03): the tenant token manager has no upstream counterpart.
/**
 * FS-03：服务 token 单飞刷新。
 *
 * The token is cached per tenant and app, and it is refreshed once when it
 * is about to expire: concurrent callers share a single refresh and only one
 * request leaves the process. Every request goes through the fixed-origin
 * transport of FS-03, so a refresh can not reach another source.
 *
 * FSL-160: a caller may pass an absolute `deadline` (milliseconds on the clock
 * of `now`). Past it the caller gets `transport_deadline` and no request is
 * made. A refresh is started by the first caller with that caller's deadline
 * (the transport bounds its HTTP attempt by it); a caller that joins a refresh
 * already in flight only waits until its own deadline and then gets
 * `transport_deadline`, while the shared refresh goes on for the others.
 * Without a `deadline` nothing changes.
 */
import { FeishuTransport, FeishuTransportError } from "./http";
import type {
  FeishuTenantCredentials,
  FeishuTenantToken,
  FeishuTenantTokenResponse,
} from "./types";

/** The frozen path of the tenant token endpoint. */
export const FEISHU_TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
/** The token is refreshed this long before it expires. */
export const FEISHU_REFRESH_MARGIN_MS = 60_000;

/** FSL-160: the options of one `getToken` call. */
export interface FeishuTokenRequestOptions {
  /**
   * The absolute deadline of this caller, in milliseconds on the clock of the manager's
   * `now` (`Date.now()` by default; it must be the clock of the transport too).
   */
  readonly deadline?: number;
}

export interface FeishuTokenManagerOptions {
  transport: FeishuTransport;
  now?: () => number;
  refreshMarginMs?: number;
}

export class FeishuTokenManager {
  private readonly transport: FeishuTransport;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;
  private readonly cache = new Map<string, FeishuTenantToken>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(options: FeishuTokenManagerOptions) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.refreshMarginMs = options.refreshMarginMs ?? FEISHU_REFRESH_MARGIN_MS;
  }

  /** The cache key of an application inside a tenant. */
  private keyOf(credentials: FeishuTenantCredentials): string {
    return `${credentials.tenantKey}\u0000${credentials.appId}`;
  }

  /**
   * Returns a live token.
   *
   * A token that is not about to expire is reused; otherwise a single
   * refresh is started and every concurrent caller awaits the same one.
   *
   * With a `deadline` (FSL-160): a caller whose deadline has passed gets
   * `transport_deadline` and nothing is requested; the first caller starts the
   * refresh with its own deadline; a caller that joins a refresh in flight
   * waits at most until its own deadline, which never cancels the refresh.
   */
  async getToken(
    credentials: FeishuTenantCredentials,
    options: FeishuTokenRequestOptions = {},
  ): Promise<string> {
    const deadline = options.deadline;
    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw new Error("INVALID_FEISHU_TOKEN_DEADLINE");
    }
    if (deadline !== undefined && deadline - this.now() <= 0) throw deadlineError();
    const key = this.keyOf(credentials);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.refreshMarginMs > this.now()) {
      return cached.token;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      return deadline === undefined ? pending : this.waitUntil(pending, deadline);
    }

    // The starter's refresh is bounded by its own deadline in the transport.
    const refresh = this.refresh(credentials, deadline)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, refresh);
    if (deadline === undefined) return refresh;
    // A token that arrives after the starter's deadline (the event loop was late) is cached
    // for the others but not handed to the starter.
    const token = await refresh;
    if (deadline - this.now() <= 0) throw deadlineError();
    return token;
  }

  /**
   * Waits for a shared refresh until `deadline` at most. The timer only ends this caller's
   * wait; the refresh itself keeps running for the caller that started it and the others.
   */
  private waitUntil(pending: Promise<string>, deadline: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(deadlineError()), Math.max(0, deadline - this.now()));
      pending.then(
        (token) => {
          clearTimeout(timer);
          // The refresh may settle before a late timer fires: the deadline is checked again on
          // the same clock, so a caller past its deadline never gets the token.
          if (deadline - this.now() <= 0) reject(deadlineError());
          else resolve(token);
        },
        (error: unknown) => {
          clearTimeout(timer);
          // Likewise a failed refresh: a caller already past its deadline gets
          // `transport_deadline`, whatever the refresh error was.
          reject(deadline - this.now() <= 0 ? deadlineError() : error);
        },
      );
    });
  }

  private async refresh(
    credentials: FeishuTenantCredentials,
    deadline: number | undefined,
  ): Promise<string> {
    const response = await this.transport.request<FeishuTenantTokenResponse>(
      FEISHU_TENANT_TOKEN_PATH,
      {
        method: "POST",
        json: {
          app_id: credentials.appId,
          app_secret: credentials.appSecret,
        },
        ...(deadline === undefined ? {} : { deadline }),
      },
    );
    const token = response.tenant_access_token;
    const expire = response.expire;
    if (!token || typeof expire !== "number" || expire <= 0) {
      throw new Error(
        "[@megaui/engine] the tenant token response is missing its token or its expiry",
      );
    }
    this.cache.set(this.keyOf(credentials), {
      token,
      expiresAt: this.now() + expire * 1000,
    });
    return token;
  }
}

function deadlineError(): FeishuTransportError {
  return new FeishuTransportError(
    "transport_deadline",
    "the request deadline passed before the token was ready",
  );
}
