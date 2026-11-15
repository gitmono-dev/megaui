import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEGA_FETCH_ERROR_CODES, MegaApiError, megaDelete, megaFetch, megaGet, megaPost, megaPut } from './fetcher'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function nonJsonResponse(status: number): Response {
  return new Response('<html>not json</html>', { status })
}

describe('megaFetch envelope unwrap (UI-04 AC2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unwraps { data } success envelopes to the bare payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: '1', title: 'hi' } }))
    const result = await megaFetch<{ id: string; title: string }>('docs/1')
    expect(result).toEqual({ id: '1', title: 'hi' })
  })

  it('forwards a structured { error: { code, message } } failure verbatim as a domain error (align with engine error codes)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'MEGA_NOT_FOUND', message: 'Doc not found: 1' } }))
    await expect(megaFetch('docs/1')).rejects.toMatchObject({
      name: 'MegaApiError',
      status: 404,
      code: 'MEGA_NOT_FOUND',
      message: 'Doc not found: 1',
    })
  })

  it('forwards MEGA_FORBIDDEN the same way as any other engine-aligned code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'MEGA_FORBIDDEN', message: 'nope' } }))
    await expect(megaFetch('cls/4')).rejects.toMatchObject({ status: 403, code: 'MEGA_FORBIDDEN', message: 'nope' })
  })

  it('falls back to MEGA_REQUEST_FAILED when a non-ok response has no parseable JSON body', async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(500))
    await expect(megaFetch('issues/7')).rejects.toMatchObject({
      status: 500,
      code: MEGA_FETCH_ERROR_CODES.REQUEST_FAILED,
    })
  })

  it('falls back to MEGA_REQUEST_FAILED when a non-ok response has a JSON body without an error envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { message: 'malformed, not enveloped' }))
    await expect(megaFetch('issues/7')).rejects.toMatchObject({
      status: 400,
      code: MEGA_FETCH_ERROR_CODES.REQUEST_FAILED,
    })
  })

  it('rejects with MEGA_INVALID_RESPONSE when an ok response is missing the data field', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: true }))
    await expect(megaFetch('issues/7')).rejects.toMatchObject({
      status: 200,
      code: MEGA_FETCH_ERROR_CODES.INVALID_RESPONSE,
    })
  })

  it('rejects ambiguous ok { data, error } envelopes (engine fail-closed parity)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: { id: '1' },
        error: { code: 'MEGA_NOT_FOUND', message: 'should not succeed' },
      }),
    )
    await expect(megaFetch('docs/1')).rejects.toMatchObject({
      status: 200,
      code: MEGA_FETCH_ERROR_CODES.INVALID_RESPONSE,
    })
  })

  it('rejects with MEGA_INVALID_RESPONSE when an ok response body is not JSON', async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(200))
    await expect(megaFetch('issues/7')).rejects.toMatchObject({
      status: 200,
      code: MEGA_FETCH_ERROR_CODES.INVALID_RESPONSE,
    })
  })

  it('thrown errors are real MegaApiError instances', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'MEGA_NOT_FOUND', message: 'nope' } }))
    await expect(megaFetch('docs/1')).rejects.toBeInstanceOf(MegaApiError)
  })
})

describe('megaUrl building', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: null }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('joins string paths under /api/mega/ and strips leading/trailing slashes', async () => {
    await megaGet('/docs/1/')
    expect(fetchMock).toHaveBeenCalledWith('/api/mega/docs/1', expect.anything())
  })

  it('joins array paths, URL-encoding each segment', async () => {
    await megaGet(['issues', 'a b'])
    expect(fetchMock).toHaveBeenCalledWith('/api/mega/issues/a%20b', expect.anything())
  })

  it('appends query params, skipping undefined values and stringifying non-strings', async () => {
    await megaGet('search', { q: 'foo', limit: 10, missing: undefined })
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string
    expect(calledUrl).toBe('/api/mega/search?q=foo&limit=10')
  })

  it('omits the query string entirely when there are no params', async () => {
    await megaGet('docs')
    expect(fetchMock).toHaveBeenCalledWith('/api/mega/docs', expect.anything())
  })
})

describe('request construction (megaGet/megaPost/megaPut/megaDelete)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: null }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('megaGet issues a same-origin GET with an Accept header, no body', async () => {
    await megaGet('docs/1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.credentials).toBe('same-origin')
    expect(init.method).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect((init.headers as Headers).get('Accept')).toBe('application/json')
  })

  it('megaPost serializes the body as JSON and sets Content-Type', async () => {
    await megaPost('issues', { title: 'hi' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ title: 'hi' }))
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json')
  })

  it('megaPost with no body omits Content-Type and sends undefined body', async () => {
    await megaPost('issues/7/watch')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect((init.headers as Headers).has('Content-Type')).toBe(false)
  })

  it('megaPut serializes the body as JSON', async () => {
    await megaPut('docs/1', { title: 'renamed' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(init.body).toBe(JSON.stringify({ title: 'renamed' }))
  })

  it('megaDelete issues a DELETE with no body', async () => {
    await megaDelete('docs/1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })
})
