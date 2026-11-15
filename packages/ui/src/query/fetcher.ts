/**
 * megaui:libs/react-shared/components/mega/query/fetcher.ts@0ff3a9d
 *
 * `megaGet`/`megaPost`/`megaPut`/`megaDelete` — the sole client-side entry
 * point into the workspace BFF (`/api/mega/*`, WA-03).
 *
 * Diff vs upstream (GC-03, registered on the UI-04 task card):
 * - Upstream imported `MegaApiSuccess`/`MegaApiFailure` from `@libs/mega`.
 *   In megaui that transport envelope lives at `@megaui/engine`'s
 *   `packages/engine/src/result.ts` (`MegaApiSuccess<T>` = `{ data: T }`,
 *   `MegaApiFailure` = `{ error: { code, message } }`) — but
 *   `packages/ui` may only depend on `core`/`content`/`i18n`
 *   (ADR-ARCH-01, enforced by `.dependency-cruiser.cjs`). This module
 *   therefore duck-types the same envelope shape structurally instead of
 *   importing it, and forwards a structured failure's `error.code` verbatim.
 *   For a `@megaui/engine`-backed BFF route that code is one of
 *   `MEGA_ERROR_CODES` (`packages/engine/src/errors.ts`) — kept in sync by
 *   convention across the package boundary, not by import.
 * - Two client-only fallback codes (`MEGA_FETCH_ERROR_CODES`) cover
 *   transport failures the envelope can't describe (non-JSON error body,
 *   an `ok` response missing `data`) — the engine never emits these; they
 *   only ever originate here.
 * - Replaced `?? undefined` style narrowing with explicit type guards
 *   (no `as any`) so the failure/success envelope checks are exhaustive.
 */

export type MegaPath = string | readonly string[]
export type MegaQueryParams = Readonly<Record<string, unknown>>

/**
 * Client-local codes for transport failures the BFF envelope doesn't cover.
 * Structured failures instead forward the server's `error.code` verbatim
 * (see module header) — these two only originate client-side.
 */
export const MEGA_FETCH_ERROR_CODES = {
  REQUEST_FAILED: 'MEGA_REQUEST_FAILED',
  INVALID_RESPONSE: 'MEGA_INVALID_RESPONSE',
} as const

export class MegaApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'MegaApiError'
    this.status = status
    this.code = code
  }
}

/** Structurally mirrors `@megaui/engine`'s `MegaApiFailure` (see module header). */
interface MegaApiFailureEnvelope {
  error: {
    code: string
    message: string
  }
}

/** Structurally mirrors `@megaui/engine`'s `MegaApiSuccess<T>` (see module header). */
interface MegaApiSuccessEnvelope<T> {
  data: T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMegaApiFailureEnvelope(value: unknown): value is MegaApiFailureEnvelope {
  if (!isRecord(value) || !isRecord(value.error)) return false
  return typeof value.error.code === 'string' && typeof value.error.message === 'string'
}

function isMegaApiSuccessEnvelope<T>(value: unknown): value is MegaApiSuccessEnvelope<T> {
  // Match engine `isMegaApiSuccess`: reject ambiguous `{ data, error }` (fail-closed).
  return isRecord(value) && 'data' in value && !('error' in value)
}

async function readPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined)
}

function megaUrl(path: MegaPath, query?: MegaQueryParams): string {
  const segments = (typeof path === 'string' ? path.split('/') : path)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    params.set(name, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const search = params.toString()
  return `/api/mega/${segments.join('/')}${search ? `?${search}` : ''}`
}

export async function megaFetch<T>(path: MegaPath, init: RequestInit = {}, query?: MegaQueryParams): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(megaUrl(path, query), {
    credentials: 'same-origin',
    ...init,
    headers,
  })
  const payload = await readPayload(response)

  if (!response.ok) {
    if (isMegaApiFailureEnvelope(payload)) {
      throw new MegaApiError(response.status, payload.error.code, payload.error.message)
    }
    throw new MegaApiError(response.status, MEGA_FETCH_ERROR_CODES.REQUEST_FAILED, `Mega request failed (${response.status})`)
  }

  if (!isMegaApiSuccessEnvelope<T>(payload)) {
    throw new MegaApiError(response.status, MEGA_FETCH_ERROR_CODES.INVALID_RESPONSE, 'Mega response did not contain data')
  }

  return payload.data
}

export function megaGet<T>(path: MegaPath, query?: MegaQueryParams): Promise<T> {
  return megaFetch<T>(path, {}, query)
}

export function megaPost<T>(path: MegaPath, body?: unknown): Promise<T> {
  return megaFetch<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function megaPut<T>(path: MegaPath, body?: unknown): Promise<T> {
  return megaFetch<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function megaDelete<T>(path: MegaPath): Promise<T> {
  return megaFetch<T>(path, { method: 'DELETE' })
}
