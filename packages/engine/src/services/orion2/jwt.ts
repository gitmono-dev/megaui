import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Orion2Config } from "./config";
import { MIN_ORION2_HMAC_SECRET_BYTES } from "./config";
import {
  isValidOrionId,
  ORION_HTTP_SCOPES,
  OrionConfigError,
  type OrionHttpScope,
} from "./types";

export const ORION2_SERVICE_JWT_TTL_SECS = 60 as const;

export interface OrionServiceJwtHeader {
  readonly alg: "HS256";
  readonly typ: "JWT";
  readonly kid: string;
}

/**
 * Matches `orion_contracts::JwtClaims` (`#[serde(deny_unknown_fields)]`):
 * `iss`, `aud` (string[]), `sub`, `environment_id`, `scope`, `nbf`, `exp`, `jti`.
 */
export interface OrionServiceJwtClaims {
  readonly iss: string;
  readonly aud: readonly string[];
  readonly sub: string;
  readonly environment_id: string;
  readonly scope: OrionHttpScope;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
}

export interface SignOrionJwtOptions {
  readonly nowSeconds?: number;
  readonly jti?: string;
  readonly sub?: string;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function assertValidScope(scope: string): asserts scope is OrionHttpScope {
  if (!(ORION_HTTP_SCOPES as readonly string[]).includes(scope)) {
    throw new OrionConfigError(
      `Unsupported Orion2 JWT scope: must be one of ${ORION_HTTP_SCOPES.join(", ")}`,
    );
  }
}

export function signOrionServiceJwt(
  config: Orion2Config,
  scope: OrionHttpScope,
  options: SignOrionJwtOptions = {},
): string {
  assertValidScope(scope);
  if (
    Buffer.byteLength(config.jwtHmacSecret, "utf8") <
    MIN_ORION2_HMAC_SECRET_BYTES
  ) {
    throw new OrionConfigError(
      `ORION2_JWT_HMAC_SECRET must be at least ${MIN_ORION2_HMAC_SECRET_BYTES} bytes`,
    );
  }

  const nowSeconds =
    options.nowSeconds !== undefined
      ? Math.floor(options.nowSeconds)
      : Math.floor(Date.now() / 1000);
  const jti = options.jti ?? `jti-${randomUUID()}`;
  if (!isValidOrionId(jti)) {
    throw new OrionConfigError("JWT jti must be a valid Orion identifier");
  }
  const sub =
    options.sub !== undefined ? options.sub.trim() : config.jwtSubject;
  if (!isValidOrionId(sub)) {
    throw new OrionConfigError("JWT sub must be a valid Orion identifier");
  }

  const header: OrionServiceJwtHeader = {
    alg: "HS256",
    typ: "JWT",
    kid: config.jwtKeyId,
  };
  const claims: OrionServiceJwtClaims = {
    iss: config.jwtIssuer,
    aud: [config.jwtAudience],
    sub,
    environment_id: config.environmentId,
    scope,
    nbf: nowSeconds,
    exp: nowSeconds + ORION2_SERVICE_JWT_TTL_SECS,
    jti,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", config.jwtHmacSecret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

export function verifyOrionServiceJwtSignature(
  token: string,
  secret: string,
): { header: OrionServiceJwtHeader; claims: OrionServiceJwtClaims } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }
  const [encodedHeader, encodedPayload, encodedSig] = parts as [
    string,
    string,
    string,
  ];
  const expected = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = Buffer.from(encodedSig, "base64url");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error("Invalid JWT signature");
  }
  const header = JSON.parse(
    Buffer.from(encodedHeader, "base64url").toString("utf8"),
  ) as OrionServiceJwtHeader;
  const claims = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  ) as OrionServiceJwtClaims;
  return { header, claims };
}
