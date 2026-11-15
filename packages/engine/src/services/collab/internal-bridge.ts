// megaui:libs/mega/services/collab-bridge.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-13 task card):
// - Upstream's `collab-bridge.ts` also derives the internal URL from
//   `MEGA_COLLAB_PUBLIC_URL` (ws→http) and ships concrete actions (rename,
//   collection append, inbox unread push) that depend on chat/collections
//   domains not yet built in this repo (EG-07..10/WA-05, out of scope for
//   this card). This port keeps only the generic config + authenticated
//   `postInternal` transport; concrete internal actions land on the cards
//   that own those domains.
// - `apps/collab-server/src/internal-api.ts` verifies inbound requests with
//   `timingSafeTokenEqual`; `verifyInternalBridgeToken` below is the same
//   constant-time contract so any future in-repo internal endpoint (or
//   CS-01 itself) can reuse one implementation instead of re-deriving it.
// - `apps/collab-server` and `apps/web` stay decoupled from each other via
//   source imports (ADR-ARCH-01) — this module only talks HTTP.
import { timingSafeEqual } from "node:crypto";

export interface CollabBridgeEnv {
  MEGA_COLLAB_INTERNAL_URL?: string;
  MEGA_COLLAB_INTERNAL_TOKEN?: string;
}

/** ER-10 bounded retry — same shape/defaults contract as `../mega2/client.ts`'s `Mega2RetryConfig`. */
export interface CollabInternalRetryConfig {
  /** ER-10 default ceiling: bounded retry, ≤ 5 attempts. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** ER-10: total retry budget. */
  maxTotalDelayMs?: number;
}

export interface CollabInternalBridgeConfig {
  internalUrl?: string;
  token?: string;
  env?: CollabBridgeEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: CollabInternalRetryConfig;
}

const DEFAULT_INTERNAL_BRIDGE_TIMEOUT_MS = 10_000;
const DEFAULT_INTERNAL_BRIDGE_MAX_ATTEMPTS = 5;
const DEFAULT_INTERNAL_BRIDGE_BASE_DELAY_MS = 200;
const DEFAULT_INTERNAL_BRIDGE_MAX_DELAY_MS = 3_000;
const DEFAULT_INTERNAL_BRIDGE_MAX_TOTAL_DELAY_MS = 30_000;

export interface CollabInternalBridgeResult {
  ok: boolean;
  /** True when the bridge isn't configured — callers should treat as best-effort skip. */
  skipped: boolean;
  status?: number;
}

function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

function resolveEnv(config?: CollabInternalBridgeConfig): CollabBridgeEnv {
  return config?.env ?? (process.env as CollabBridgeEnv);
}

export function resolveCollabInternalUrl(
  config?: CollabInternalBridgeConfig,
): string | null {
  const explicit = config?.internalUrl?.trim();
  if (explicit) return trimTrailingSlashes(explicit);
  const fromEnv = resolveEnv(config).MEGA_COLLAB_INTERNAL_URL?.trim();
  return fromEnv ? trimTrailingSlashes(fromEnv) : null;
}

export function resolveCollabInternalToken(
  config?: CollabInternalBridgeConfig,
): string | null {
  const explicit = config?.token?.trim();
  if (explicit) return explicit;
  const fromEnv = resolveEnv(config).MEGA_COLLAB_INTERNAL_TOKEN?.trim();
  return fromEnv || null;
}

export function isCollabBridgeConfigured(
  config?: CollabInternalBridgeConfig,
): boolean {
  return Boolean(
    resolveCollabInternalUrl(config) && resolveCollabInternalToken(config),
  );
}

function isUnicodeSpace(value: string): boolean {
  return value.length === 1 && value.trim() === "";
}

function readBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.slice(0, 6).toLowerCase() !== "bearer") return null;
  const rest = trimmed.slice(6);
  if (!isUnicodeSpace(rest[0] ?? "")) return null;
  let index = 0;
  while (index < rest.length && isUnicodeSpace(rest[index] ?? "")) index += 1;
  const token = rest.slice(index).trim();
  return token || null;
}

/**
 * Constant-time bearer compare. A length mismatch still walks a dummy
 * compare of `expected`'s length instead of returning early, so a timing
 * side channel can't leak the secret's length (GC-07/ER-11) — mirrors
 * `@megaui/core`'s collab ticket signature compare.
 */
function timingSafeTokenEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length === 0 || right.length === 0) return false;
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length, 0));
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Verify an inbound internal-bridge request's `Authorization` header.
 * Fail-closed: an unconfigured token, a missing/malformed header, and a
 * mismatched token are all indistinguishable `false` — the caller must not
 * leak *why* a request was rejected (GC-07/ER-11).
 */
export function verifyInternalBridgeToken(
  authorizationHeader: string | null | undefined,
  config?: CollabInternalBridgeConfig,
): boolean {
  const expected = resolveCollabInternalToken(config);
  if (!expected) return false;
  const provided = readBearer(authorizationHeader);
  if (!provided) return false;
  return timingSafeTokenEqual(expected, provided);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

/** ER-10: 429/5xx are transient (rate-limited/overloaded collab-server); every other status is a deterministic failure and must not be retried. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** `fetch` itself rejecting (DNS, connection refused/reset, TLS) surfaces as a `TypeError` in both Node's undici and the browser fetch spec — transient network failure, not a caller mistake. */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function isTransientFetchError(error: unknown): boolean {
  return isAbortOrTimeoutError(error) || isNetworkError(error);
}

/**
 * Outbound client for engine-side calls into collab-server `/internal/*`
 * routes. Skips (rather than throws) when unconfigured so callers can treat
 * collab as an optional best-effort integration in environments where
 * DEP-01 isn't wired yet.
 */
export function createCollabInternalBridge(
  config?: CollabInternalBridgeConfig,
) {
  function resolved(): { baseUrl: string; token: string; fetchImpl: typeof fetch } | null {
    const baseUrl = resolveCollabInternalUrl(config);
    const token = resolveCollabInternalToken(config);
    if (!baseUrl || !token) return null;
    return { baseUrl, token, fetchImpl: config?.fetchImpl ?? fetch };
  }

  /**
   * ER-10 bounded retry — same shape as `../mega2/client.ts`'s
   * `mega2Fetch`: transient failures (timeout/abort, network errors,
   * HTTP 429/5xx) get capped exponential backoff up to `maxAttempts`
   * (default 5) within a total delay budget; a deterministic 4xx status
   * (other than 429) is returned on the first attempt.
   *
   * A raw fetch exception (network error, or a timeout/abort after
   * exhausting the retry budget) never escapes this function — collab
   * stays a best-effort integration, so an exhausted transient failure is
   * reported the same way a non-ok HTTP response already is: `{ ok:
   * false, skipped: false }` (no `status`, since no HTTP response was
   * ever received), never a thrown error.
   */
  async function postInternal(
    path: string,
    body: unknown,
  ): Promise<CollabInternalBridgeResult> {
    const target = resolved();
    if (!target) return { ok: false, skipped: true };

    const timeoutMs = config?.timeoutMs ?? DEFAULT_INTERNAL_BRIDGE_TIMEOUT_MS;
    const maxAttempts = Math.max(1, config?.retry?.maxAttempts ?? DEFAULT_INTERNAL_BRIDGE_MAX_ATTEMPTS);
    const baseDelayMs = config?.retry?.baseDelayMs ?? DEFAULT_INTERNAL_BRIDGE_BASE_DELAY_MS;
    const maxDelayMs = config?.retry?.maxDelayMs ?? DEFAULT_INTERNAL_BRIDGE_MAX_DELAY_MS;
    const maxTotalDelayMs = config?.retry?.maxTotalDelayMs ?? DEFAULT_INTERNAL_BRIDGE_MAX_TOTAL_DELAY_MS;

    let elapsedDelayMs = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      let thrown: unknown;
      try {
        response = await target.fetchImpl(`${target.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${target.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
      } catch (error) {
        thrown = error;
      } finally {
        clearTimeout(timeout);
      }

      const transient = response
        ? !response.ok && isRetryableStatus(response.status)
        : isTransientFetchError(thrown);
      const isLastAttempt = attempt >= maxAttempts;
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      const withinBudget = elapsedDelayMs + delayMs <= maxTotalDelayMs;

      if (!transient || isLastAttempt || !withinBudget) {
        if (response) return { ok: response.ok, skipped: false, status: response.status };
        return { ok: false, skipped: false };
      }

      elapsedDelayMs += delayMs;
      await sleep(delayMs);
    }
    // Unreachable — the loop above always returns on its last iteration.
    return { ok: false, skipped: false };
  }

  function isConfigured(): boolean {
    return resolved() !== null;
  }

  async function appendCollectionChild(
    roomName: string,
    childId: string,
  ): Promise<CollabInternalBridgeResult> {
    return postInternal("/internal/collection/append", { roomName, childId });
  }

  async function bumpCollectionRevision(
    roomName: string,
    revision: { kind: string; messageId: string; at?: number },
  ): Promise<CollabInternalBridgeResult> {
    return postInternal("/internal/collection/bump", {
      roomName,
      kind: revision.kind,
      messageId: revision.messageId,
      at: revision.at ?? Date.now(),
    });
  }

  return { postInternal, appendCollectionChild, bumpCollectionRevision, isConfigured };
}

export type CollabInternalBridge = ReturnType<typeof createCollabInternalBridge>;
