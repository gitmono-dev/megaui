// megaui-only (FS-03): the tenant token manager has no upstream counterpart.
/**
 * FS-03：服务 token 单飞刷新。
 *
 * The token is cached per tenant and app, and it is refreshed once when it
 * is about to expire: concurrent callers share a single refresh and only one
 * request leaves the process. Every request goes through the fixed-origin
 * transport of FS-03, so a refresh can not reach another source.
 */
import { FeishuTransport } from "./http";
import type {
  FeishuTenantCredentials,
  FeishuTenantToken,
  FeishuTenantTokenResponse,
} from "./types";

/** The frozen path of the tenant token endpoint. */
export const FEISHU_TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
/** The token is refreshed this long before it expires. */
export const FEISHU_REFRESH_MARGIN_MS = 60_000;

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
   */
  async getToken(credentials: FeishuTenantCredentials): Promise<string> {
    const key = this.keyOf(credentials);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.refreshMarginMs > this.now()) {
      return cached.token;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const refresh = this.refresh(credentials)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, refresh);
    return refresh;
  }

  private async refresh(credentials: FeishuTenantCredentials): Promise<string> {
    const response = await this.transport.request<FeishuTenantTokenResponse>(
      FEISHU_TENANT_TOKEN_PATH,
      {
        method: "POST",
        json: {
          app_id: credentials.appId,
          app_secret: credentials.appSecret,
        },
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
