// megaui:packages/auth/src/enterprise-otp/plugin.ts@24a8551 (megaui-only FSL-123: the Feishu login flow cookie)
/**
 * FSL-123: the flow cookie of the Feishu login (ADR-FSL-11 「请求」).
 *
 * A flow is 256 random bits in canonical unpadded base64url (43 characters). The cookie is
 * `__Host-megaui.feishu-login-flow`, HttpOnly, Secure, SameSite=Lax, Path=/, with no Domain,
 * and lives 10 minutes from the latest request (each request sets it again, so it never expires
 * inside the 5-minute life of the newest code). The server keeps no plain flow: the issue port
 * and the code table only see its SHA-256 as 64 lowercase hex characters.
 */
import { createHash, randomBytes } from "node:crypto";

export const FEISHU_LOGIN_FLOW_COOKIE = "__Host-megaui.feishu-login-flow";
/** Ten minutes, counted again on every request. */
export const FEISHU_LOGIN_FLOW_MAX_AGE_SECONDS = 600;

const FLOW_BYTES = 32;
const FLOW_SYNTAX = /^[A-Za-z0-9_-]{43}$/;

export interface FeishuLoginFlowCookie {
  readonly name: typeof FEISHU_LOGIN_FLOW_COOKIE;
  readonly value: string;
  readonly path: "/";
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax";
  readonly maxAge: typeof FEISHU_LOGIN_FLOW_MAX_AGE_SECONDS;
}

/** True only for the canonical base64url text of exactly 32 bytes. */
export function isFeishuLoginFlow(value: unknown): value is string {
  if (typeof value !== "string" || !FLOW_SYNTAX.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === FLOW_BYTES && bytes.toString("base64url") === value;
}

/**
 * Reads the flow from a `Cookie` request header. Returns the flow only when the header carries
 * the flow cookie exactly once and its value is a canonical flow; anything else (no header, no
 * such cookie, a duplicate, a malformed value) yields `undefined`, and the request then starts
 * a new flow.
 */
export function readFeishuLoginFlowCookie(header: string | null | undefined): string | undefined {
  if (typeof header !== "string" || header.length === 0) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== FEISHU_LOGIN_FLOW_COOKIE) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return isFeishuLoginFlow(found) ? found : undefined;
}

/** A fresh flow: 256 bits from the CSPRNG, canonical base64url. */
export function createFeishuLoginFlow(): string {
  return randomBytes(FLOW_BYTES).toString("base64url");
}

/** The SHA-256 of the flow, as 64 lowercase hex characters (the store's `flow_hash`). */
export function feishuLoginFlowHash(flow: string): string {
  return createHash("sha256").update(flow, "utf8").digest("hex");
}

/** The cookie that (re)binds the browser to `flow` for the next ten minutes. */
export function feishuLoginFlowCookie(flow: string): FeishuLoginFlowCookie {
  return {
    name: FEISHU_LOGIN_FLOW_COOKIE,
    value: flow,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: FEISHU_LOGIN_FLOW_MAX_AGE_SECONDS,
  };
}
