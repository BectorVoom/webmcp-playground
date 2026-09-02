import { Effect } from 'effect'
import type { LonLat } from '../../domain/geo'
import { SourceRateLimited, SourceUnavailable, type GeoError } from '../../domain/geo-errors'

export const resolveApiUrl = (path: string): string => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return path
  }
  const base =
    (typeof process !== 'undefined' && (process.env?.BACKEND_API_URL || process.env?.VITE_BACKEND_API_URL)) ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_BACKEND_API_URL) ||
    'http://127.0.0.1:8787'
  return `${String(base).replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

export const getWebMcpHeaders = (): Record<string, string> => {
  const secret =
    (typeof process !== 'undefined' && (process.env?.WEBMCP_SHARED_SECRET || process.env?.VITE_WEBMCP_SHARED_SECRET)) ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WEBMCP_SHARED_SECRET)
  return secret ? { 'x-webmcp-secret': secret } : {}
}

export type GeoProxyKind = 'flood' | 'places' | 'alerts' | 'geocode'

export interface ProxyRequest {
  readonly kind: GeoProxyKind
  /**
   * Where the question is being asked. Optional only for `geocode`, which is the one request that
   * has no coordinates yet — finding them is the request.
   */
  readonly at?: LonLat
  readonly sourceId: string
  /** The upstream the server should call on our behalf. Must be on the server's host allowlist. */
  readonly upstreamUrl: string
  readonly radiusKm?: number
  /** The place name being resolved. Geocode only; the server keys its cache on it. */
  readonly searchQuery?: string
  readonly method?: 'GET' | 'POST'
  /** Sent as the upstream request body. Overpass needs this; the JSON feeds do not. */
  readonly upstreamBody?: string
  readonly signal?: AbortSignal
}

export interface ProxyResponse {
  /** The upstream's own body, verbatim. JSON for JMA/NWS/Overpass, XML for MeteoAlarm. */
  readonly text: string
  readonly cacheHit: boolean
  readonly cacheAgeMs: number
  /**
   * The server answered from fixtures instead of calling upstream — it is in fixture mode, or it
   * would not call the URL we asked for. The caller must fall back rather than parse this.
   */
  readonly servedFromFixture: boolean
}

interface FixtureEnvelope {
  readonly ok?: unknown
  readonly mode?: unknown
  readonly data?: unknown
}

/**
 * A fixture envelope is the server saying "I did not call your upstream". It is JSON shaped
 * nothing like JMA's or NWS's payloads, so this only has to be careful enough not to mistake a
 * real upstream body for one.
 */
const isFixtureEnvelope = (text: string): boolean => {
  if (!text.startsWith('{')) return false
  try {
    const parsed = JSON.parse(text) as FixtureEnvelope
    return parsed?.ok === true && parsed?.mode === 'fixture' && 'data' in parsed
  } catch {
    return false
  }
}

/**
 * Calls an upstream hazard source through the server proxy.
 *
 * Nothing here talks to `api.weather.gov` or `www.jma.go.jp` directly, for three reasons that all
 * have to hold at once: the browser would be blocked by CORS, the upstream host allowlist and the
 * circuit breaker live on the server, and any API key must never reach the bundle. The server
 * returns the upstream's body untouched, so each adapter parses its own source's real format.
 */
export const fetchViaProxy = (
  fetchImpl: typeof fetch,
  request: ProxyRequest,
): Effect.Effect<ProxyResponse, GeoError> =>
  Effect.gen(function* () {
    const { kind, at, sourceId, upstreamUrl, radiusKm, searchQuery, method, upstreamBody, signal } =
      request

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(resolveApiUrl(`/api/geo/${kind}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...getWebMcpHeaders() },
          body: JSON.stringify({
            at: at ? { latitude: at.latitude, longitude: at.longitude } : undefined,
            sourceId,
            upstreamUrl,
            radiusKm,
            query: searchQuery,
            upstreamMethod: method,
            upstreamBody,
          }),
          signal,
        }),
      catch: (err) =>
        new SourceUnavailable({
          sourceId,
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    })

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (err) =>
        new SourceUnavailable({
          sourceId,
          message: `Failed to read proxy response body: ${String(err)}`,
          cause: err,
        }),
    })

    if (!response.ok) {
      if (response.status === 429) {
        const resetHeader =
          response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset')
        return yield* Effect.fail(
          new SourceRateLimited({
            sourceId,
            resetAt: resetHeader ? Number(resetHeader) * 1000 + Date.now() : undefined,
          }),
        )
      }
      return yield* Effect.fail(
        new SourceUnavailable({
          sourceId,
          message: `Proxy returned HTTP ${response.status}: ${text.slice(0, 300)}`,
        }),
      )
    }

    return {
      text,
      cacheHit: response.headers.get('x-cache-hit') === 'true',
      cacheAgeMs: Number(response.headers.get('x-cache-age-ms') ?? '0'),
      servedFromFixture: isFixtureEnvelope(text),
    }
  })

/** Parses an upstream JSON body, turning a malformed one into a typed source failure. */
export const parseUpstreamJson = <T>(
  sourceId: string,
  text: string,
): Effect.Effect<T, GeoError> =>
  Effect.try({
    try: () => JSON.parse(text) as T,
    catch: () =>
      new SourceUnavailable({
        sourceId,
        message: `Upstream returned a body that is not JSON: ${text.slice(0, 200)}`,
      }),
  })

export interface RasterResponse {
  readonly bytes: ArrayBuffer
  readonly cacheHit: boolean
  /** The server answered from fixtures instead of calling upstream; the caller must fall back. */
  readonly servedFromFixture: boolean
}

/**
 * Fetches a raster through the server proxy, for a source whose URL the client has to build.
 *
 * Separate from `fetchViaProxy` because these bodies are PNG. The JSON path reads the response as
 * text, which decodes the bytes as UTF-8 and destroys every pixel that is not ASCII.
 */
export const fetchRasterViaProxy = (
  fetchImpl: typeof fetch,
  request: {
    readonly sourceId: string
    readonly upstreamUrl: string
    readonly ttlMs?: number
    readonly signal?: AbortSignal
  },
): Effect.Effect<RasterResponse, GeoError> =>
  Effect.gen(function* () {
    const { sourceId, upstreamUrl, ttlMs, signal } = request

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(resolveApiUrl('/api/geo/raster'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...getWebMcpHeaders() },
          body: JSON.stringify({ sourceId, upstreamUrl, ttlMs }),
          signal,
        }),
      catch: (err) =>
        new SourceUnavailable({
          sourceId,
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    })

    if (!response.ok) {
      if (response.status === 429) {
        return yield* Effect.fail(new SourceRateLimited({ sourceId }))
      }
      return yield* Effect.fail(
        new SourceUnavailable({ sourceId, message: `Proxy returned HTTP ${response.status}` }),
      )
    }

    // The fixture envelope is JSON, and JSON is the one thing a PNG response never is.
    const servedFromFixture = (response.headers.get('content-type') ?? '').includes('application/json')

    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (err) =>
        new SourceUnavailable({
          sourceId,
          message: `Failed to read raster body: ${String(err)}`,
          cause: err,
        }),
    })

    return {
      bytes,
      cacheHit: response.headers.get('x-cache-hit') === 'true',
      servedFromFixture,
    }
  })
