// megaui-only (FSL-121): Web configuration of the Feishu email-code login.
/**
 * FSL-121：飞书登录必填配置的校验（ADR-FSL-12）。
 *
 * `readFeishuLoginConfig(source)` reads and validates the three keys the
 * Feishu email-code login requires. It is a pure function: the caller passes
 * the raw values (for example `process.env`), and nothing is wired yet
 * (FSL-150 wires it into Web; FSL-148 adds the provider selection).
 *
 * - `FEISHU_APP_ID` and `FEISHU_APP_SECRET`: non-empty, at most 256
 *   characters, with no whitespace or ASCII control characters (a value
 *   padded with spaces is refused rather than trimmed).
 * - `ENTERPRISE_OTP_HMAC_KEY`: the canonical unpadded base64url encoding of
 *   exactly 32 bytes (43 characters that decode and re-encode to themselves).
 *
 * A missing, blank or invalid key fails closed with
 * `INVALID_FEISHU_LOGIN_CONFIG`. The error names every offending key and
 * never carries a value; the secret and the key stay in process memory only.
 */

export const INVALID_FEISHU_LOGIN_CONFIG = "INVALID_FEISHU_LOGIN_CONFIG" as const;

/** The required keys, in the order an error lists them. */
export const FEISHU_LOGIN_REQUIRED_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "ENTERPRISE_OTP_HMAC_KEY",
] as const;
export type FeishuLoginConfigKey = (typeof FEISHU_LOGIN_REQUIRED_KEYS)[number];

export type FeishuLoginConfigSource = Readonly<Partial<Record<FeishuLoginConfigKey, string | undefined>>>;

export interface FeishuLoginConfig {
  readonly appId: string;
  /** Private. Never log it or return it over HTTP. */
  readonly appSecret: string;
  /** Private 32-byte HMAC key (decoded `ENTERPRISE_OTP_HMAC_KEY`). Never log it. */
  readonly otpHmacKey: Uint8Array;
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

/** Reads the required Feishu login keys (ADR-FSL-12); fails closed with `INVALID_FEISHU_LOGIN_CONFIG`. */
export function readFeishuLoginConfig(source: FeishuLoginConfigSource): Readonly<FeishuLoginConfig> {
  const appId = identifier(source.FEISHU_APP_ID);
  const appSecret = identifier(source.FEISHU_APP_SECRET);
  const otpHmacKey = hmacKey(source.ENTERPRISE_OTP_HMAC_KEY);

  const invalid: FeishuLoginConfigKey[] = [];
  if (appId === undefined) invalid.push("FEISHU_APP_ID");
  if (appSecret === undefined) invalid.push("FEISHU_APP_SECRET");
  if (otpHmacKey === undefined) invalid.push("ENTERPRISE_OTP_HMAC_KEY");
  if (appId === undefined || appSecret === undefined || otpHmacKey === undefined) {
    throw new FeishuLoginConfigError(invalid);
  }

  return Object.freeze({ appId, appSecret, otpHmacKey });
}
