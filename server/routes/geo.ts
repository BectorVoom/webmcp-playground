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
  readonly fixtureData?: unknown
  readonly locations?: ReadonlyArray<unknown>
}

export const geoRoutes = (config: ServerConfig, proxyService?: GeoProxyService) => {
  const router = new Hono<AppEnv>()
  const proxy = proxyService ?? new GeoProxyService(config)

  // GET /api/geo/providers (R7.11, R6.7)
  router.get('/providers', (c) => {
    const stats = proxy.getStats()
    return c.json({
      ok: true,
      dataMode: config.geoDataMode,
      routingBaseUrl: config.routingBaseUrl,
      routingConfigured: Boolean(config.routingApiKey || config.routingBaseUrl),
      mapTilesConfigured: Boolean(config.mapTileUrl),
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
      const cacheKey = `flood:${sourceId}:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}:${body.radiusKm ?? 20}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlFloodMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl)
      proxy.setCache(cacheKey, JSON.parse(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HostNotAllowed')) {
        return c.json({ error: 'HostNotAllowed', message: msg }, 403)
      }
      if (msg.includes('SourceCircuitOpen')) {
        return c.json({ error: 'SourceCircuitOpen', message: msg }, 503)
      }
      if (msg.includes('UpstreamTooLarge')) {
        return c.json({ error: 'UpstreamTooLarge', message: msg }, 413)
      }
      return c.json({ error: 'UpstreamFailed', message: msg }, 502)
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
      const cacheKey = `places:${sourceId}:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}:${body.radiusKm ?? 20}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlPlacesMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl)
      proxy.setCache(cacheKey, JSON.parse(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HostNotAllowed')) {
        return c.json({ error: 'HostNotAllowed', message: msg }, 403)
      }
      if (msg.includes('SourceCircuitOpen')) {
        return c.json({ error: 'SourceCircuitOpen', message: msg }, 503)
      }
      return c.json({ error: 'UpstreamFailed', message: msg }, 502)
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
      const cacheKey = `alerts:${sourceId}:${latitude.toFixed(config.geoCoordPrecision)},${longitude.toFixed(config.geoCoordPrecision)}`
      const cached = proxy.getCache(cacheKey, config.geoCacheTtlAlertsMs)
      if (cached) {
        c.header('x-cache-hit', 'true')
        c.header('x-cache-age-ms', String(cached.ageMs))
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(sourceId, targetUrl)
      proxy.setCache(cacheKey, JSON.parse(res.body), res.body, res.status, res.contentType)

      c.header('x-cache-hit', 'false')
      c.header('x-cache-age-ms', '0')
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HostNotAllowed')) {
        return c.json({ error: 'HostNotAllowed', message: msg }, 403)
      }
      if (msg.includes('SourceCircuitOpen')) {
        return c.json({ error: 'SourceCircuitOpen', message: msg }, 503)
      }
      return c.json({ error: 'UpstreamFailed', message: msg }, 502)
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

    const sourceId = 'global.valhalla.routing'
    const targetUrl = `${config.routingBaseUrl}/route`

    if (config.geoDataMode === 'fixture' || !config.routingBaseUrl) {
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

  // GET /api/geo/tiles/:source/:z/:x/:y (R4.8, R7.9)
  router.get('/tiles/:source/:z/:x/:y', async (c) => {
    const { source, z, x, y } = c.req.param()
    const tileY = y.replace(/\.(png|jpg|webp|geojson)$/, '')

    const getTileUrl = (): string | null => {
      if (source === 'jp-flood') {
        return `https://cyberjapandata.gsi.go.jp/xyz/hazardmap_flood_l2_shinsuisin_data/${z}/${x}/${tileY}.png`
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
        return c.text(cached.entry.rawText, cached.entry.status as ContentfulStatusCode, {
          'content-type': cached.entry.contentType,
        })
      }

      const res = await proxy.fetchUpstream(source, tileHostUrl)
      proxy.setCache(cacheKey, null, res.body, res.status, res.contentType)
      return c.text(res.body, res.status as ContentfulStatusCode, { 'content-type': res.contentType })
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
