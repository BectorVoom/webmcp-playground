import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { loadConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import { geoRoutes } from './geo'

/**
 * The proxy is the only place that knows the routing engine's address and its key. The browser
 * asks this server for `/api/geo/route` and never learns either — which is the point, and also
 * why a mistake here is invisible from the client: a wrong path 404s, a missing key 401s, and
 * both arrive at the UI as "no route found".
 */

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

interface UpstreamCall {
  readonly sourceId: string
  readonly targetUrl: string
  readonly body: string | undefined
}

/** Records what the route handler asked for, and answers with whatever the case under test needs. */
class RecordingProxy extends GeoProxyService {
  readonly calls: Array<UpstreamCall> = []
  private readonly reply: { status: number; body: string }

  constructor(
    config: Parameters<typeof geoRoutes>[0],
    reply: { status: number; body: string } = { status: 200, body: '{"trip":{"legs":[]}}' },
  ) {
    super(config)
    this.reply = reply
  }

  override async fetchUpstream(
    sourceId: string,
    targetUrl: string,
    options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
  ) {
    this.calls.push({ sourceId, targetUrl, body: options.body })
    return {
      status: this.reply.status,
      body: this.reply.body,
      contentType: 'application/json',
      redactedUrl: this.redactUrl(targetUrl),
    }
  }
}

const appWith = (
  env: Record<string, string | undefined>,
  reply?: { status: number; body: string },
): { app: Hono; proxy: RecordingProxy } => {
  // ROUTING_MODE=live so these exercise the live path regardless of whether a key is set; with
  // the default `auto`, a keyless config resolves to the recordings and never calls out at all.
  const config = run(loadConfig({ ROUTING_MODE: 'live', ...env }))
  const proxy = new RecordingProxy(config, reply)
  const app = new Hono()
  app.route('/api/geo', geoRoutes(config, proxy))
  return { app, proxy }
}

const routeRequest = (app: Hono) =>
  app.request('/api/geo/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [
        { lat: 35.6812, lon: 139.7671 },
        { lat: 35.677, lon: 139.764 },
      ],
      costing: 'pedestrian',
    }),
  })

describe('routing through Stadia Maps', () => {
  it('posts to the Stadia route endpoint, not a bare Valhalla path', async () => {
    const { app, proxy } = appWith({ ROUTING_API_KEY: 'test-key' })
    await routeRequest(app)

    const call = proxy.calls[0]!
    expect(new URL(call.targetUrl).origin).toBe('https://api.stadiamaps.com')
    // Stadia serves /route/v1; /route is the bare Valhalla path and 404s there.
    expect(new URL(call.targetUrl).pathname).toBe('/route/v1')
    expect(call.sourceId).toBe('global.stadia.routing')
  })

  it('attaches the API key Stadia requires', async () => {
    const { app, proxy } = appWith({ ROUTING_API_KEY: 'test-key' })
    await routeRequest(app)

    expect(new URL(proxy.calls[0]!.targetUrl).searchParams.get('api_key')).toBe('test-key')
  })

  it('escapes a key so a stray character cannot alter the query', async () => {
    const { app, proxy } = appWith({ ROUTING_API_KEY: 'a b&costing=auto' })
    await routeRequest(app)

    const url = new URL(proxy.calls[0]!.targetUrl)
    expect(url.searchParams.get('api_key')).toBe('a b&costing=auto')
    expect(url.searchParams.get('costing')).toBeNull()
  })

  it('keeps the key out of anything written down', async () => {
    const { app, proxy } = appWith({ ROUTING_API_KEY: 'super-secret-key' })
    await routeRequest(app)

    const redacted = proxy.redactUrl(proxy.calls[0]!.targetUrl)
    expect(redacted).not.toContain('super-secret-key')
    expect(redacted).toContain('[REDACTED]')
  })

  it('sends no api_key parameter at all when none is configured', async () => {
    const { app, proxy } = appWith({})
    await routeRequest(app)

    // An empty `api_key=` is not the same as none: some engines reject it outright.
    expect(proxy.calls[0]!.targetUrl).not.toContain('api_key')
  })

  it('forwards the Valhalla request body untouched, alternates and all', async () => {
    const { app, proxy } = appWith({ ROUTING_API_KEY: 'k' })
    await app.request('/api/geo/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [
          { lat: 35.6812, lon: 139.7671 },
          { lat: 35.677, lon: 139.764 },
        ],
        costing: 'pedestrian',
        alternates: 2,
        exclude_polygons: [[[139.7, 35.6]]],
      }),
    })

    const sent = JSON.parse(proxy.calls[0]!.body!)
    expect(sent.alternates).toBe(2)
    expect(sent.costing).toBe('pedestrian')
    expect(sent.exclude_polygons).toHaveLength(1)
  })

  it('routes live while the hazard data stays simulated, which is the default install', async () => {
    // The bug this covers: routing followed GEO_DATA_MODE, so the out-of-the-box fixture mode
    // drew no routes anywhere but the one street corner the recordings were captured at.
    const config = run(loadConfig({ GEO_DATA_MODE: 'fixture', ROUTING_API_KEY: 'k' }))
    const proxy = new RecordingProxy(config)
    const app = new Hono()
    app.route('/api/geo', geoRoutes(config, proxy))

    await routeRequest(app)
    expect(proxy.calls).toHaveLength(1)
    expect(new URL(proxy.calls[0]!.targetUrl).hostname).toBe('api.stadiamaps.com')
  })

  it('tells the client which routing mode it is in, so it picks the matching provider', async () => {
    const config = run(loadConfig({ GEO_DATA_MODE: 'fixture', ROUTING_API_KEY: 'k' }))
    const app = new Hono()
    app.route('/api/geo', geoRoutes(config, new RecordingProxy(config)))

    const body = (await (await app.request('/api/geo/providers')).json()) as {
      dataMode: string
      routingMode: string
    }
    expect(body.dataMode).toBe('fixture')
    expect(body.routingMode).toBe('live')
  })

  it('still routes to a bare Valhalla when pointed at one', async () => {
    const { app, proxy } = appWith({
      ROUTING_BASE_URL: 'https://valhalla1.openstreetmap.de',
      ROUTING_ROUTE_PATH: '/route',
    })
    await routeRequest(app)

    expect(proxy.calls[0]!.targetUrl).toBe('https://valhalla1.openstreetmap.de/route')
  })

  it('serves the recorded reply without calling out at all when routing is on recordings', async () => {
    const config = run(loadConfig({ ROUTING_MODE: 'fixture' }))
    const proxy = new RecordingProxy(config)
    const app = new Hono()
    app.route('/api/geo', geoRoutes(config, proxy))

    const res = await routeRequest(app)
    expect(res.status).toBe(200)
    expect((await res.json() as { mode: string }).mode).toBe('fixture')
    expect(proxy.calls).toHaveLength(0)
  })

  describe('when Stadia rejects the key', () => {
    it('names the variable to set rather than passing on "No valid authentication provided."', async () => {
      const { app } = appWith({}, { status: 401, body: '{"error":"No valid authentication provided."}' })

      const res = await routeRequest(app)
      const json = (await res.json()) as { error: string; message: string }

      expect(res.status).toBe(502)
      expect(json.error).toBe('RoutingAuthRequired')
      expect(json.message).toContain('ROUTING_API_KEY')
      expect(json.message).toContain('api.stadiamaps.com')
    })

    it('treats a 403 the same way, since a revoked key reads as a forbidden one', async () => {
      const { app } = appWith({ ROUTING_API_KEY: 'revoked' }, { status: 403, body: '{}' })

      const res = await routeRequest(app)
      expect(((await res.json()) as { error: string }).error).toBe('RoutingAuthRequired')
    })

    it('does not leak the rejected key into the message', async () => {
      const { app } = appWith(
        { ROUTING_API_KEY: 'super-secret-key' },
        { status: 401, body: '{}' },
      )

      const res = await routeRequest(app)
      expect(await res.text()).not.toContain('super-secret-key')
    })
  })

  it('passes a real routing failure through as an engine outage, not an auth problem', async () => {
    const { app } = appWith({ ROUTING_API_KEY: 'k' }, { status: 400, body: '{"error_code":154}' })

    const res = await routeRequest(app)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('154')
  })
})

describe('ROUTING_ROUTE_PATH validation', () => {
  it('rejects a path that is not a path', () => {
    const failure = Effect.runSync(
      Effect.either(loadConfig({ ROUTING_ROUTE_PATH: 'route/v1' })),
    )
    expect(failure._tag).toBe('Left')
    if (failure._tag !== 'Left') return
    expect(failure.left.variable).toBe('ROUTING_ROUTE_PATH')
  })

  it('rejects a query string, which belongs to the key handling and nothing else', () => {
    const failure = Effect.runSync(
      Effect.either(loadConfig({ ROUTING_ROUTE_PATH: '/route/v1?api_key=leaked' })),
    )
    expect(failure._tag).toBe('Left')
  })
})
