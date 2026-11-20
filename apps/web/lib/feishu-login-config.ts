// megaui-only (FSL-121, FSL-148): Web configuration of the Feishu email-code login.
/**
 * FSL-121：飞书登录必填配置的校验（ADR-FSL-12）；FSL-148：provider 选择。
 *
 * `readFeishuLoginConfig(source)` reads and validates the three keys the
 * Feishu email-code login requires, then selects the provider target. It is a
 * pure function: the caller passes the raw values (for example `process.env`),
 * and nothing is wired yet (FSL-150 wires it into Web).
 *
 * - `FEISHU_APP_ID` and `FEISHU_APP_SECRET`: non-empty, at most 256
 *   characters, with no whitespace or ASCII control characters (a value
 *   padded with spaces is refused rather than trimmed).
 * - `ENTERPRISE_OTP_HMAC_KEY`: the canonical unpadded base64url encoding of
 *   exactly 32 bytes (43 characters that decode and re-encode to themselves).
 * - `FEISHU_PROVIDER` (optional): unset or blank selects `feishu`, the
 *   official origin. `simulator` follows the existing `admitProvider` rules
 *   of `@megaui/core`: only with `NODE_ENV` `development` or `test`, and only
 *   with `FEISHU_SIMULATOR_ORIGIN` the exact loopback origin
 *   `http://127.0.0.1:<port>`. Any other value is refused.
 * - `FEISHU_SIMULATOR_ORIGIN`: read only for the `simulator` provider.
 *
 * A missing, blank or invalid key fails closed with
 * `INVALID_FEISHU_LOGIN_CONFIG`. The error names every offending key and
 * never carries a value; the secret and the key stay in process memory only.
 */

import { admitProvider, ProviderAdmissionError, type ProviderTarget } from "@megaui/core";

export const INVALID_FEISHU_LOGIN_CONFIG = "INVALID_FEISHU_LOGIN_CONFIG" as const;

/** The required keys, in the order an error lists them. */
export const FEISHU_LOGIN_REQUIRED_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "ENTERPRISE_OTP_HMAC_KEY",
] as const;
export type FeishuLoginRequiredKey = (typeof FEISHU_LOGIN_REQUIRED_KEYS)[number];

/** The optional provider-selection keys (FSL-148), listed after the required ones in an error. */
export const FEISHU_LOGIN_PROVIDER_KEYS = ["FEISHU_PROVIDER", "FEISHU_SIMULATOR_ORIGIN"] as const;
export type FeishuLoginProviderKey = (typeof FEISHU_LOGIN_PROVIDER_KEYS)[number];

/** Every key an `INVALID_FEISHU_LOGIN_CONFIG` error may name. */
export type FeishuLoginConfigKey = FeishuLoginRequiredKey | FeishuLoginProviderKey;

export type FeishuLoginConfigSource = Readonly<
  Partial<Record<FeishuLoginConfigKey | "NODE_ENV", string | undefined>>
>;

export interface FeishuLoginConfig {
  readonly appId: string;
  /** Private. Never log it or return it over HTTP. */
  readonly appSecret: string;
  /** Private 32-byte HMAC key (decoded `ENTERPRISE_OTP_HMAC_KEY`). Never log it. */
  readonly otpHmacKey: Uint8Array;
  /** The single frozen provider target (FSL-148); never replaced per request. */
  readonly target: ProviderTarget;
}

export class FeishuLoginConfigError extends Error {
  readonly code = INVALID_FEISHU_LOGIN_CONFIG;
  /** The offending keys only, never their values. */
  readonly keys: readonly FeishuLoginConfigKey[];

  constructor(keys: readonly FeishuLoginConfigKey[]) {
    super(`${INVALID_FEISHU_LOGIN_CONFIG}: ${keys.join(", ")}`);
    this.name = "FeishuLoginConfigError";
    this.keys = Object.freeze([...keys]);
  }
}

const MAX_IDENTIFIER_LENGTH = 256;
const HMAC_KEY_BYTES = 32;
// 32 bytes encode to 43 unpadded base64url characters.
const HMAC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whitespace or an ASCII control character anywhere in the value. */
function hasSpaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127 || /\s/u.test(character)) return true;
  }
  return false;
}

function identifier(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return undefined;
  return hasSpaceOrControl(value) ? undefined : value;
}

function hmacKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || !HMAC_KEY_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== HMAC_KEY_BYTES || decoded.toString("base64url") !== value) return undefined;
  return Uint8Array.from(decoded);
}

type ProviderSelection =
  | { readonly target: ProviderTarget; readonly invalid?: undefined }
  | { readonly target?: undefined; readonly invalid: FeishuLoginProviderKey };

/**
 * Selects the provider target with the existing `admitProvider` rules (FSL-148).
 *
 * Only `NODE_ENV` decides whether the simulator is trusted: `development` and
 * `test` are both the deployment role and the `NODE_ENV` passed on; anything
 * else, including an unset `NODE_ENV`, is treated as `production`.
 */
function selectProvider(source: FeishuLoginConfigSource): ProviderSelection {
  const raw = source.FEISHU_PROVIDER?.trim();
  const nodeEnv = source.NODE_ENV === "development" || source.NODE_ENV === "test" ? source.NODE_ENV : "production";
  const provider = raw === undefined || raw === "" ? "feishu" : raw;
  try {
    const target = admitProvider({
      enabled: true,
      provider,
      role: nodeEnv,
      nodeEnv,
      // Read only for the simulator; the official target never looks at it.
      simulatorOrigin: provider === "simulator" ? source.FEISHU_SIMULATOR_ORIGIN : undefined,
    });
    // `enabled: true` always yields a target or throws; this guard keeps the selection fail-closed.
    return target === undefined ? { invalid: "FEISHU_PROVIDER" } : { target };
  } catch (error) {
    if (error instanceof ProviderAdmissionError && error.code === "provider_origin_invalid") {
      return { invalid: "FEISHU_SIMULATOR_ORIGIN" };
    }
    // `provider_unknown`, `provider_role_untrusted`, `provider_env_untrusted` and anything unexpected.
    return { invalid: "FEISHU_PROVIDER" };
  }
}

/**
 * Reads the Feishu login keys (ADR-FSL-12) and selects the provider (FSL-148);
 * fails closed with `INVALID_FEISHU_LOGIN_CONFIG`.
 */
export function readFeishuLoginConfig(source: FeishuLoginConfigSource): Readonly<FeishuLoginConfig> {
  const appId = identifier(source.FEISHU_APP_ID);
  const appSecret = identifier(source.FEISHU_APP_SECRET);
  const otpHmacKey = hmacKey(source.ENTERPRISE_OTP_HMAC_KEY);
  const selection = selectProvider(source);

  const invalid: FeishuLoginConfigKey[] = [];
  if (appId === undefined) invalid.push("FEISHU_APP_ID");
  if (appSecret === undefined) invalid.push("FEISHU_APP_SECRET");
  if (otpHmacKey === undefined) invalid.push("ENTERPRISE_OTP_HMAC_KEY");
  if (selection.invalid !== undefined) invalid.push(selection.invalid);
  if (appId === undefined || appSecret === undefined || otpHmacKey === undefined || selection.target === undefined) {
    throw new FeishuLoginConfigError(invalid);
  }

  return Object.freeze({ appId, appSecret, otpHmacKey, target: selection.target });
}
