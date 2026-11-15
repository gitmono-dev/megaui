// megaui-only (FS-03): the Feishu credential types have no upstream counterpart.
/**
 * FS-03：飞书租户凭据、token 与 HTTP 结果的类型。
 */

/** The credentials of one tenant application. */
export interface FeishuTenantCredentials {
  tenantKey: string;
  appId: string;
  appSecret: string;
}

/** A tenant access token and its absolute expiry. */
export interface FeishuTenantToken {
  token: string;
  /** The expiry as milliseconds since the epoch. */
  expiresAt: number;
}

/** The frozen response of the tenant token endpoint. */
export interface FeishuTenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}
