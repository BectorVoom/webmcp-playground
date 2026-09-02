import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ServerConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import type { AppEnv } from '../env'

interface GeoLocationInput {
  readonly latitude?: number
  readonly longitude?: number
}

interface GeoRequestBody {
  readonly at?: GeoLocationInput
  readonly sourceId?: string
  readonly upstreamUrl?: string
  readonly radiusKm?: number
  /** Geocode only: the place name being resolved. Keys the cache, and is what gets validated. */
  readonly query?: string
  readonly fixtureData?: unknown
  readonly locations?: ReadonlyArray<unknown>
  /** Overpass is queried by POST; the JSON feeds are all GET. */
  readonly upstreamMethod?: 'GET' | 'POST'
  readonly upstreamBody?: string
}

interface RasterRequestBody {
  readonly sourceId?: string
  /** The raster the server should fetch on our behalf. Must be on the host allowlist. */
  readonly upstreamUrl?: string
  /** Cache lifetime hint; clamped to the configured tile TTL. */
  readonly ttlMs?: number
}

/**
 * Upstream bodies are cached as text, and parsed only so a JSON one can be cached structurally.
 * MeteoAlarm answers in XML and FEMA can answer in XML on error, so a bare `JSON.parse` here took
 * the whole route down with a SyntaxError on a response that was perfectly valid.
 */
const parsedOrNull = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

const base64ToBytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Distinguishes upstreams that share a route and a location — a JMA office, an Overpass query. */
const upstreamKey = (url: string, body?: string): string => {
  const source = body ? `${url}\u0000${body}` : url
  let hash = 5381
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

/**
 * The upstream failures every proxy route maps the same way. Four routes had grown four copies of
 * this ladder and they had already drifted — `/places` and `/alerts` never mapped `UpstreamTooLarge`
 * and answered 502 for a response that was merely too big to be worth reading.
 */
export const upstreamErrorStatus = (message: string): { error: string; status: ContentfulStatusCode } => {
  if (message.includes('HostNotAllowed')) return { error: 'HostNotAllowed', status: 403 }
  if (message.includes('SourceCircuitOpen')) return { error: 'SourceCircuitOpen', status: 503 }
  if (message.includes('UpstreamTooLarge')) return { error: 'UpstreamTooLarge', status: 413 }
  return { error: 'UpstreamFailed', status: 502 }
}

/** The longest place name worth asking about; beyond this it is a paste, not a query. */
const MAX_GEOCODE_QUERY_LENGTH = 200

export const geoRoutes = (config: ServerConfig, proxyService?: GeoProxyService) => {
  const router = new Hono<AppEnv>()
  const proxy = proxyService ?? new GeoProxyService(config)

  // GET /api/geo/providers (R7.11, R6.7)
  router.get('/providers', (c) => {
    const stats = proxy.getStats()
    return c.json({
      ok: true,
      dataMode: config.geoDataMode,
      // Routing has a mode of its own, and the client picks its routing provider from this rather
      // than from `dataMode` — see ServerConfig.routingMode.
      routingMode: config.routingMode,
      routingBaseUrl: config.routingBaseUrl,
      routingRoutePath: config.routingRoutePath,
      routingConfigured: config.routingMode === 'live',
      mapTilesConfigured: Boolean(config.mapTileUrl),
      // The client caps its own tile fan-out, but the server pays for the requests, so the number
      // belongs to the server. Reported here because `GEO_TILE_CAP` was configurable, documented,
      // and read by nothing at all — the client had its own hardcoded 64.
      tileCap: config.geoTileCap,
      allowedHosts: config.geoAllowedHosts,
      stats,
    })
  })

  // POST /api/geo/flood (R7.1, R7.2)
  router.post('/flood', async (c) => {
    let body: GeoRequestBody
    try {
      body = (await c.req.json()) as GeoRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    if (!body || typeof body !== 'object' || !body.at) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at', message: 'Missing coordinates object {latitude, longitude}' }],
        },
        400,
      )
    }

    const { latitude, longitude } = body.at
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at.latitude', message: 'Must be a valid latitude between -90 and 90' }],
        },
        400,
      )
    }
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at.longitude', message: 'Must be a valid longitude between -180 and 180' }],
        },
        400,
      )
    }

    const sourceId = body.sourceId ?? 'flood-service'
    const targetUrl = body.upstreamUrl

    if (config.geoDataMode === 'fixture' || !targetUrl) {
      return c.json({
        ok: true,
        mode: 'fixture',
        sourceId,
        cached: false,
        data: body.fixtureData ?? null,
      })
    }

    try {
      const cacheKey = `flood:${sourceId}:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}:${body.radiusKm ?? 20}:${upstreamKey(targetUrl, body.upstreamBody)}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlFloodMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl, {
        method: body.upstreamMethod ?? 'GET',
        body: body.upstreamBody,
      })
      proxy.setCache(cacheKey, parsedOrNull(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  // POST /api/geo/places (R7.1, R7.2)
  router.post('/places', async (c) => {
    let body: GeoRequestBody
    try {
      body = (await c.req.json()) as GeoRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    if (!body || typeof body !== 'object' || !body.at) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at', message: 'Missing coordinates object' }],
        },
        400,
      )
    }

    const { latitude, longitude } = body.at
    if (typeof latitude !== 'number' || !Number.isFinite(latitude)) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at.latitude', message: 'Must be a valid number' }],
        },
        400,
      )
    }
    if (typeof longitude !== 'number' || !Number.isFinite(longitude)) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at.longitude', message: 'Must be a valid number' }],
        },
        400,
      )
    }

    const sourceId = body.sourceId ?? 'places-service'
    const targetUrl = body.upstreamUrl

    if (config.geoDataMode === 'fixture' || !targetUrl) {
      return c.json({
        ok: true,
        mode: 'fixture',
        sourceId,
        cached: false,
        data: body.fixtureData ?? null,
      })
    }

    try {
      const cacheKey = `places:${sourceId}:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}:${body.radiusKm ?? 20}:${upstreamKey(targetUrl, body.upstreamBody)}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlPlacesMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl, {
        method: body.upstreamMethod ?? 'GET',
        body: body.upstreamBody,
      })
      proxy.setCache(cacheKey, parsedOrNull(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  /**
   * POST /api/geo/geocode (R7.1, R7.2)
   *
   * The one proxy route with no coordinates in its request: producing them is the point. So the
   * cache key and the validation are built on the query text instead, and a request that arrives
   * without one is rejected here rather than forwarded as an empty search that Nominatim would
   * answer with an arbitrary place.
   */
  router.post('/geocode', async (c) => {
    let body: GeoRequestBody
    try {
      body = (await c.req.json()) as GeoRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (query === '') {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'query', message: 'Missing place name to resolve' }],
        },
        400,
      )
    }
    if (query.length > MAX_GEOCODE_QUERY_LENGTH) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [
            {
              field: 'query',
              message: `Place name exceeds ${MAX_GEOCODE_QUERY_LENGTH} characters`,
            },
          ],
        },
        400,
      )
    }

    const sourceId = body.sourceId ?? 'geocode-service'
    const targetUrl = body.upstreamUrl

    if (config.geoDataMode === 'fixture' || !targetUrl) {
      return c.json({
        ok: true,
        mode: 'fixture',
        sourceId,
        cached: false,
        data: body.fixtureData ?? null,
      })
    }

    try {
      // Keyed on the normalised query as well as the URL: the same place asked for twice in one
      // session must cost one upstream call, which is what Nominatim's usage policy asks for.
      const cacheKey = `geocode:${sourceId}:${query.toLowerCase()}:${upstreamKey(targetUrl)}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlGeocodeMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl, { method: 'GET' })
      proxy.setCache(cacheKey, parsedOrNull(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  // POST /api/geo/alerts (R7.1, R7.2)
  router.post('/alerts', async (c) => {
    let body: GeoRequestBody
    try {
      body = (await c.req.json()) as GeoRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    if (!body || typeof body !== 'object' || !body.at) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at', message: 'Missing coordinates object' }],
        },
        400,
      )
    }

    const { latitude, longitude } = body.at
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'at', message: 'Invalid latitude or longitude numbers' }],
        },
        400,
      )
    }

    const sourceId = body.sourceId ?? 'alerts-service'
    const targetUrl = body.upstreamUrl

    if (config.geoDataMode === 'fixture' || !targetUrl) {
      return c.json({
        ok: true,
        mode: 'fixture',
        sourceId,
        cached: false,
        data: body.fixtureData ?? null,
      })
    }

    try {
      const cacheKey = `alerts:${sourceId}:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}:${upstreamKey(targetUrl, body.upstreamBody)}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlAlertsMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl, {
        method: body.upstreamMethod ?? 'GET',
        body: body.upstreamBody,
      })
      proxy.setCache(cacheKey, parsedOrNull(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  // POST /api/geo/route (R7.1, R7.2)
  router.post('/route', async (c) => {
    let body: GeoRequestBody
    try {
      body = (await c.req.json()) as GeoRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    if (!body || !body.locations || !Array.isArray(body.locations) || body.locations.length < 2) {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'locations', message: 'At least origin and destination locations required' }],
        },
        400,
      )
    }

    const sourceId = 'global.stadia.routing'
    // The key travels as a query parameter because that is what Stadia Maps accepts. It never
    // reaches a log or a trace in that form: `redactUrl` masks `api_key` before anything is
    // written, and the browser only ever sees this server's own `/api/geo/route`.
    const targetUrl = `${config.routingBaseUrl}${config.routingRoutePath}${
      config.routingApiKey ? `?api_key=${encodeURIComponent(config.routingApiKey)}` : ''
    }`

    // Gated on the routing mode, not the global data mode: simulated flood zones and shelters are
    // still recognisably what they represent, but a simulated route is not a route.
    if (config.routingMode === 'fixture' || !config.routingBaseUrl) {
      return c.json({
        ok: true,
        mode: 'fixture',
        sourceId,
        cached: false,
        data: body.fixtureData ?? null,
      })
    }

    try {
      const res = await proxy.fetchUpstream(sourceId, targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      // A rejected key is a configuration mistake, not an outage, and forwarding Stadia's bare
      // "No valid authentication provided." leaves the reader to guess which of several keys is
      // meant. Name the variable instead; the client falls back to recorded routes either way,
      // and this is the only thing that says why it did.
      if (res.status === 401 || res.status === 403) {
        return c.json(
          {
            error: 'RoutingAuthRequired',
            message: `${new URL(config.routingBaseUrl).hostname} rejected the routing request (HTTP ${res.status}). Set ROUTING_API_KEY to a Stadia Maps API key, or point ROUTING_BASE_URL and ROUTING_ROUTE_PATH at an engine that needs none.`,
          },
          502,
        )
      }

      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HostNotAllowed')) {
        return c.json({ error: 'HostNotAllowed', message: msg }, 403)
      }
      if (msg.includes('SourceCircuitOpen')) {
        return c.json({ error: 'SourceCircuitOpen', message: msg }, 503)
      }
      return c.json({ error: 'RoutingUnavailable', message: msg }, 502)
    }
  })

  /**
   * POST /api/geo/raster (R7.1, R7.2, R7.8)
   *
   * Bytes in, bytes out, for a raster whose URL only the client can build. The `/tiles/:source`
   * route constructs the upstream URL itself from a fixed template, which works for a plain
   * `{z}/{x}/{y}` scheme and not at all for the two sources that need this one: JMA's キキクル
   * embeds a basetime, a member and a validtime that come from its own index, and GloFAS is a WMS
   * `GetMap` with a bbox. The allowlist, the breaker and the cache still apply — the client picks
   * the URL, the server still decides whether it may be called.
   *
   * Binary rather than the JSON proxy because these are PNGs: reading them through the text path
   * decodes them as UTF-8 and silently mangles every non-ASCII byte.
   */
  router.post('/raster', async (c) => {
    let body: RasterRequestBody
    try {
      body = (await c.req.json()) as RasterRequestBody
    } catch {
      return c.json({ error: 'ValidationError', message: 'Malformed JSON body' }, 400)
    }

    const targetUrl = typeof body?.upstreamUrl === 'string' ? body.upstreamUrl : ''
    const sourceId = body.sourceId ?? 'raster-service'
    if (targetUrl === '') {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'upstreamUrl', message: 'Missing raster URL to fetch' }],
        },
        400,
      )
    }
    try {
      const parsed = new URL(targetUrl)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme')
    } catch {
      return c.json(
        {
          error: 'ValidationError',
          fields: [{ field: 'upstreamUrl', message: 'Must be an absolute http(s) URL' }],
        },
        400,
      )
    }

    // Fixture mode never calls out, exactly as the other proxy routes behave.
    if (config.geoDataMode === 'fixture') {
      return c.json({ ok: true, mode: 'fixture', sourceId, cached: false, data: null })
    }

    try {
      const cacheKey = `raster:${sourceId}:${upstreamKey(targetUrl)}`
      const ttlMs = Math.min(body.ttlMs ?? config.geoCacheTtlTilesMs, config.geoCacheTtlTilesMs)
      const cached = proxy.getCache<null>(cacheKey, ttlMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.body(base64ToBytes(cached.entry.rawText), cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstreamBinary(sourceId, targetUrl)
      proxy.setCache(cacheKey, null, bytesToBase64(res.bytes), res.status, res.contentType)
      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.body(res.bytes, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const { error, status } = upstreamErrorStatus(msg)
      return c.json({ error, message: msg }, status)
    }
  })

  // GET /api/geo/tiles/:source/:z/:x/:y (R4.8, R7.9)
  router.get('/tiles/:source/:z/:x/:y', async (c) => {
    const { source, z, x, y } = c.req.param()
    const tileY = y.replace(/\.(png|jpg|webp|geojson)$/, '')

    const getTileUrl = (): string | null => {
      if (source === 'jp-flood') {
        // The hazard rasters live on disaportaldata, not cyberjapandata, and the path is
        // `shinsuishin` (浸水深). The old cyberjapandata URL 404s at every zoom, everywhere.
        return `https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/${z}/${x}/${tileY}.png`
      }
      if (source === 'jp-shelters' || source === 'jp-skhb') {
        return `https://cyberjapandata.gsi.go.jp/xyz/skhb/${z}/${x}/${tileY}.geojson`
      }
      if (source === 'jp-std') {
        return `https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${x}/${tileY}.png`
      }
      if (config.mapTileUrl) {
        let url = config.mapTileUrl
          .replace('{z}', z)
          .replace('{x}', x)
          .replace('{y}', tileY)
        if (config.mapTileKey) {
          url += (url.includes('?') ? '&' : '?') + `key=${config.mapTileKey}`
        }
        return url
      }
      return null
    }

    const tileHostUrl = getTileUrl()
    if (!tileHostUrl) {
      return c.json({ error: 'NoTileSourceConfigured', message: `Tile source "${source}" not configured` }, 404)
    }

    try {
      const cacheKey = `tile:${source}:${z}:${x}:${tileY}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlTilesMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.body(base64ToBytes(cached.entry.rawText), cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      // Tiles are PNG. They go out as bytes, and are cached base64-encoded so the text cache can
      // hold them without a UTF-8 round trip destroying every pixel.
      const res = await proxy.fetchUpstreamBinary(source, tileHostUrl)
      proxy.setCache(cacheKey, null, bytesToBase64(res.bytes), res.status, res.contentType)
      c.header('x-cache-hit', 'false')
      return c.body(res.bytes, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HostNotAllowed')) {
        return c.json({ error: 'HostNotAllowed', message: msg }, 403)
      }
      return c.json({ error: 'TileFetchFailed', message: msg }, 502)
    }
  })

  return router
}
