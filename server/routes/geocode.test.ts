import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { loadConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import { geoRoutes } from './geo'

/**
 * `/api/geo/geocode` is the one proxy route with no coordinates in its request — producing them is
 * the request. So everything the other routes key on location, this keys on the query text, and
 * the validation that stops a nonsense call reaching Nominatim lives here rather than upstream.
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

const UPSTREAM = 'https://nominatim.openstreetmap.org/search?q=Fukui+Station&format=jsonv2'
const REPLY = '[{"name":"福井駅","lat":"36.0621411","lon":"136.2221908"}]'

class RecordingProxy extends GeoProxyService {
  readonly calls: Array<{ sourceId: string; targetUrl: string; method?: string }> = []

  override async fetchUpstream(
    sourceId: string,
    targetUrl: string,
    options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
  ) {
    this.calls.push({ sourceId, targetUrl, method: options.method })
    return {
      status: 200,
      body: REPLY,
      contentType: 'application/json',
      redactedUrl: this.redactUrl(targetUrl),
    }
  }
}

const appWith = (env: Record<string, string | undefined> = { GEO_DATA_MODE: 'live' }) => {
  const config = run(loadConfig(env))
  const proxy = new RecordingProxy(config)
  const app = new Hono()
  app.route('/api/geo', geoRoutes(config, proxy))
  return { app, proxy }
}

const geocode = (app: Hono, body: unknown) =>
  app.request('/api/geo/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/geo/geocode', () => {
  it('forwards the search to the upstream the adapter chose', async () => {
    const { app, proxy } = appWith()
    const res = await geocode(app, {
      query: 'Fukui Station',
      sourceId: 'global.osm.nominatim',
      upstreamUrl: UPSTREAM,
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(REPLY)
    expect(proxy.calls[0]?.targetUrl).toBe(UPSTREAM)
    expect(proxy.calls[0]?.method).toBe('GET')
    expect(res.headers.get('x-cache-hit')).toBe('false')
  })

  it('answers the same place twice from cache, which is what the usage policy asks for', async () => {
    const { app, proxy } = appWith()
    await geocode(app, { query: 'Fukui Station', sourceId: 'geo', upstreamUrl: UPSTREAM })
    const second = await geocode(app, { query: 'Fukui Station', sourceId: 'geo', upstreamUrl: UPSTREAM })

    expect(proxy.calls.length).toBe(1)
    expect(second.headers.get('x-cache-hit')).toBe('true')
    expect(await second.text()).toBe(REPLY)
  })

  it('rejects a request with no place name instead of forwarding an empty search', async () => {
    const { app, proxy } = appWith()
    const res = await geocode(app, { sourceId: 'geo', upstreamUrl: UPSTREAM })

    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('ValidationError')
    expect(proxy.calls).toEqual([])
  })

  it('rejects a whitespace-only place name the same way', async () => {
    const { app } = appWith()
    expect((await geocode(app, { query: '   ', upstreamUrl: UPSTREAM })).status).toBe(400)
  })

  it('rejects a paste rather than a query', async () => {
    const { app } = appWith()
    const res = await geocode(app, { query: 'x'.repeat(201), upstreamUrl: UPSTREAM })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { fields: Array<{ message: string }> }
    expect(body.fields[0]?.message).toContain('200')
  })

  it('rejects a malformed body', async () => {
    const { app } = appWith()
    const res = await app.request('/api/geo/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('answers from fixtures without calling out in fixture mode', async () => {
    const { app, proxy } = appWith({ GEO_DATA_MODE: 'fixture' })
    const res = await geocode(app, { query: 'Fukui Station', upstreamUrl: UPSTREAM })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, mode: 'fixture' })
    expect(proxy.calls).toEqual([])
  })

  it('refuses a host that is not on the allowlist', async () => {
    const config = run(loadConfig({ GEO_DATA_MODE: 'live' }))
    const app = new Hono()
    app.route('/api/geo', geoRoutes(config, new GeoProxyService(config)))

    const res = await geocode(app, {
      query: 'Fukui Station',
      sourceId: 'geo',
      upstreamUrl: 'https://geocoder.example.com/search?q=Fukui',
    })

    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('HostNotAllowed')
  })

  it('allows Nominatim, which is what the geocoder actually calls', async () => {
    const config = run(loadConfig({}))
    expect(config.geoAllowedHosts).toContain('nominatim.openstreetmap.org')
  })
})

describe('GET /api/geo/providers', () => {
  /**
   * `GEO_TILE_CAP` was configurable, documented in `.env.example`, and read by nothing: the client
   * carried its own hardcoded 64, so raising the variable changed nothing at all. It now travels
   * with the rest of the server's state on the probe the client already makes.
   */
  it('reports the tile cap, which is the server\'s to decide', async () => {
    const { app } = appWith({ GEO_TILE_CAP: '128' })
    const body = (await (await app.request('/api/geo/providers')).json()) as { tileCap?: number }

    expect(body.tileCap).toBe(128)
  })

  it('defaults to a cap that covers the widest query the tools allow', async () => {
    const { app } = appWith({})
    const body = (await (await app.request('/api/geo/providers')).json()) as { tileCap?: number }

    // 441 tiles at zoom 14 for a 20 km radius.
    expect(body.tileCap).toBeGreaterThanOrEqual(441)
  })
})

describe('POST /api/geo/raster', () => {
  /**
   * The binary sibling of the JSON proxy, for the two sources whose URL only the client can build:
   * キキクル embeds a basetime, a member and a validtime from its own index, and GloFAS is a WMS
   * GetMap with a bbox. Neither fits the `/tiles/:source/:z/:x/:y` template.
   */
  const PNG = 'https://www.jma.go.jp/bosai/jmatile/data/risk/20260830014000/immed0/20260830014000/surf/inund/12/3597/1607.png'

  it('rejects a request with no URL rather than fetching something arbitrary', async () => {
    const { app } = appWith()
    const res = await app.request('/api/geo/raster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'jp.jma.kikikuru' }),
    })

    expect(res.status).toBe(400)
  })

  it('rejects a URL that is not http(s)', async () => {
    const { app } = appWith()
    const res = await app.request('/api/geo/raster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstreamUrl: 'file:///etc/passwd' }),
    })

    expect(res.status).toBe(400)
  })

  it('refuses a host that is not on the allowlist, even though the client picked the URL', async () => {
    const config = run(loadConfig({ GEO_DATA_MODE: 'live' }))
    const app = new Hono()
    app.route('/api/geo', geoRoutes(config, new GeoProxyService(config)))

    const res = await app.request('/api/geo/raster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'x', upstreamUrl: 'https://tiles.example.com/1/2/3.png' }),
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('HostNotAllowed')
  })

  it('allows the two hosts the new sources actually use', () => {
    const config = run(loadConfig({}))
    expect(config.geoAllowedHosts).toContain('www.jma.go.jp')
    expect(config.geoAllowedHosts).toContain('ows.globalfloods.eu')
  })

  it('answers from fixtures without calling out in fixture mode', async () => {
    const { app } = appWith({ GEO_DATA_MODE: 'fixture' })
    const res = await app.request('/api/geo/raster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'jp.jma.kikikuru', upstreamUrl: PNG }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, mode: 'fixture' })
  })
})
