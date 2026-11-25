import { readFileSync } from "node:fs";
import {
  isValidOrionId,
  isValidOrionTarget,
  OrionConfigError,
} from "./types";

export const DEFAULT_ORION2_TIMEOUT_MS = 15_000;
export const MIN_ORION2_HMAC_SECRET_BYTES = 32;
export const DEFAULT_ORION2_JWT_ISSUER = "https://orion.test/issuer";
export const DEFAULT_ORION2_JWT_AUDIENCE = "orion.v1.server";
export const DEFAULT_ORION2_JWT_SUBJECT = "service-megaui";
export const DEFAULT_ORION2_JWT_KEY_ID = "default";
export const DEFAULT_ORION2_ENVIRONMENT_ID = "default";
export const DEFAULT_ORION2_TARGETS = ["//:"] as const;

export interface Orion2Config {
  readonly baseUrl: string;
  readonly jwtHmacSecret: string;
  readonly jwtKeyId: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly jwtSubject: string;
  readonly environmentId: string;
  readonly defaultTargets: readonly string[];
  readonly timeoutMs: number;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function parseBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OrionConfigError("ORION2_BASE_URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OrionConfigError("ORION2_BASE_URL must use http or https scheme");
  }
  if (parsed.username || parsed.password) {
    throw new OrionConfigError("ORION2_BASE_URL must not contain embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new OrionConfigError("ORION2_BASE_URL must not contain query or fragment");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new OrionConfigError("ORION2_BASE_URL must not include a path prefix");
  }
  return trimTrailingSlashes(parsed.origin);
}

function resolveHmacSecret(env: NodeJS.ProcessEnv): string {
  const inline = env.ORION2_JWT_HMAC_SECRET;
  const secretFile = env.ORION2_JWT_HMAC_SECRET_FILE?.trim();
  let secret: string | undefined;

  if (inline !== undefined && inline.length > 0) {
    secret = inline;
  } else if (secretFile) {
    try {
      secret = readFileSync(secretFile, "utf8").replace(/[\r\n]+$/, "");
    } catch {
      throw new OrionConfigError(
        "ORION2_JWT_HMAC_SECRET_FILE could not be read",
      );
    }
  }

  if (!secret) {
    throw new OrionConfigError(
      "ORION2_JWT_HMAC_SECRET is required when ORION2_BASE_URL is configured",
    );
  }
  if (Buffer.byteLength(secret, "utf8") < MIN_ORION2_HMAC_SECRET_BYTES) {
    throw new OrionConfigError(
      `ORION2_JWT_HMAC_SECRET must be at least ${MIN_ORION2_HMAC_SECRET_BYTES} bytes`,
    );
  }
  return secret;
}

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw || raw.trim() === "") {
    return DEFAULT_ORION2_TIMEOUT_MS;
  }
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new OrionConfigError("ORION2_TIMEOUT_MS must be a positive integer");
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 500 || value > 120_000) {
    throw new OrionConfigError(
      "ORION2_TIMEOUT_MS must be between 500 and 120000 ms",
    );
  }
  return value;
}

function parseDefaultTargets(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim() === "") {
    return [...DEFAULT_ORION2_TARGETS];
  }
  const targets = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (targets.length === 0) {
    throw new OrionConfigError(
      "ORION2_DEFAULT_TARGETS must contain at least one valid Buck2 target",
    );
  }
  for (const target of targets) {
    if (!isValidOrionTarget(target)) {
      throw new OrionConfigError(
        `ORION2_DEFAULT_TARGETS contains invalid target: ${target}`,
      );
    }
  }
  return targets;
}

function parseSubject(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_ORION2_JWT_SUBJECT;
  }
  const sub = raw.trim();
  if (!isValidOrionId(sub)) {
    throw new OrionConfigError("ORION2_JWT_SUBJECT must be a valid Orion ID");
  }
  return sub;
}

export function isOrion2Configured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const baseUrl = env.ORION2_BASE_URL?.trim();
  return Boolean(baseUrl && baseUrl.length > 0);
}

export function resolveOrion2Config(
  env: NodeJS.ProcessEnv = process.env,
): Orion2Config {
  const rawBaseUrl = env.ORION2_BASE_URL?.trim();
  if (!rawBaseUrl) {
    throw new OrionConfigError("ORION2_BASE_URL is not configured");
  }

  const baseUrl = parseBaseUrl(rawBaseUrl);
  const jwtHmacSecret = resolveHmacSecret(env);
  const jwtKeyId = env.ORION2_JWT_KEY_ID?.trim() || DEFAULT_ORION2_JWT_KEY_ID;
  if (!isValidOrionId(jwtKeyId)) {
    throw new OrionConfigError("ORION2_JWT_KEY_ID must be a valid Orion ID");
  }

  const jwtIssuer = env.ORION2_JWT_ISSUER?.trim() || DEFAULT_ORION2_JWT_ISSUER;
  const jwtAudience =
    env.ORION2_JWT_AUDIENCE?.trim() || DEFAULT_ORION2_JWT_AUDIENCE;
  const jwtSubject = parseSubject(env.ORION2_JWT_SUBJECT);
  const environmentId =
    env.ORION2_ENVIRONMENT_ID?.trim() || DEFAULT_ORION2_ENVIRONMENT_ID;
  if (!isValidOrionId(environmentId)) {
    throw new OrionConfigError(
      "ORION2_ENVIRONMENT_ID must be a valid Orion ID",
    );
  }

  const defaultTargets = parseDefaultTargets(env.ORION2_DEFAULT_TARGETS);
  const timeoutMs = parseTimeoutMs(env.ORION2_TIMEOUT_MS);

  return Object.freeze({
    baseUrl,
    jwtHmacSecret,
    jwtKeyId,
    jwtIssuer,
    jwtAudience,
    jwtSubject,
    environmentId,
    defaultTargets,
    timeoutMs,
  });
}
