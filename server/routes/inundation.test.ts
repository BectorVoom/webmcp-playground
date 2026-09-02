import { Effect } from 'effect'
import { Hono } from 'hono'
import { PNG } from 'pngjs'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import { inundationRoutes } from './inundation'
import { resetStaticCaches } from '../static-cache'

// Terrain, climatology and embankments are cached per location, so one test's
// stubbed upstream would otherwise answer the next test's question.
beforeEach(() => resetStaticCaches())

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

/** Terrarium-encodes a synthetic tile: elevation must be a whole number of metres. */
const terrariumTile = (elevationAt: (row: number, col: number) => number): Uint8Array => {
  const png = new PNG({ width: 256, height: 256 })
  for (let row = 0; row < 256; row++) {
    for (let col = 0; col < 256; col++) {
      const value = elevationAt(row, col) + 32768
      const offset = (row * 256 + col) * 4
      png.data[offset] = (value >> 8) & 255
      png.data[offset + 1] = value & 255
      png.data[offset + 2] = 0
      png.data[offset + 3] = 255
    }
  }
  return new Uint8Array(PNG.sync.write(png))
}

interface Upstreams {
  readonly jsonBody?: string
  readonly tileBytes?: Uint8Array
}

class FakeProxy extends GeoProxyService {
  readonly jsonUrls: Array<string> = []
  readonly tileUrls: Array<string> = []
  private readonly upstreams: Upstreams

  constructor(config: Parameters<typeof inundationRoutes>[0], upstreams: Upstreams = {}) {
    super(config)
    this.upstreams = upstreams
  }

  override async fetchUpstream(_sourceId: string, targetUrl: string) {
    this.jsonUrls.push(targetUrl)
    return {
      status: 200,
      body: this.upstreams.jsonBody ?? '{}',
      contentType: 'application/json',
      redactedUrl: targetUrl,
    }
  }

  override async fetchUpstreamBinary(_sourceId: string, targetUrl: string) {
    this.tileUrls.push(targetUrl)
    return {
      status: 200,
      bytes: (this.upstreams.tileBytes ?? new Uint8Array(0)) as Uint8Array<ArrayBuffer>,
      contentType: 'image/png',
      redactedUrl: targetUrl,
    }
  }
}

const appWith = (env: Record<string, string | undefined>, upstreams?: Upstreams) => {
  const config = run(loadConfig(env))
  const proxy = new FakeProxy(config, upstreams)
  const app = new Hono()
  app.route('/api/geo', inundationRoutes(config, proxy))
  return { app, proxy }
}

const estimate = (app: Hono, body: unknown) =>
  app.request('/api/geo/inundation-estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/geo/inundation-estimate — validation', () => {
  it('rejects a missing coordinates object', async () => {
    const { app } = appWith({})
    const res = await estimate(app, { radiusKm: 5 })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { fields: Array<{ field: string }> }
    expect(json.fields[0]!.field).toBe('at.latitude')
  })

  it('rejects a radius beyond the 20 km the estimate is built for', async () => {
    const { app } = appWith({})
    const res = await estimate(app, { at: { latitude: 35.68, longitude: 139.77 }, radiusKm: 25 })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { fields: Array<{ field: string }> }
    expect(json.fields[0]!.field).toBe('radiusKm')
  })

  it('rejects an out-of-range curve number and design storm', async () => {
    const { app } = appWith({})
    const at = { latitude: 35.68, longitude: 139.77 }
    expect((await estimate(app, { at, curveNumber: 20 })).status).toBe(400)
    expect((await estimate(app, { at, rainfallMm: 5000 })).status).toBe(400)
  })
})

describe('POST /api/geo/inundation-estimate — fixture mode', () => {
  it('runs the full pipeline offline on synthetic terrain and conserves volume', async () => {
    const { app, proxy } = appWith({ GEO_DATA_MODE: 'fixture' })
    const res = await estimate(app, {
      at: { latitude: 35.68, longitude: 139.77 },
      radiusKm: 2,
      rainfallMm: 150,
      curveNumber: 85,
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      runoff: { runoffMm: number }
      inundation: {
        maxDepthMetres: number
        floodedAreaKm2: number
        volume: { generatedM3: number; pondedM3: number; drainedM3: number }
        zones: Array<{ hazardClass: string; kind: { kind: string }; geometry: { type: string } }>
      }
      provenance: { mode: string }
      limitations: Array<string>
    }

    expect(json.ok).toBe(true)
    expect(proxy.jsonUrls).toHaveLength(0)
    expect(proxy.tileUrls).toHaveLength(0)

    // 150 mm on CN 85: S = 44.8 mm, Ia = 8.96 mm, Q ≈ 107 mm.
    expect(json.runoff.runoffMm).toBeGreaterThan(100)
    expect(json.runoff.runoffMm).toBeLessThan(115)

    // The synthetic bowl ponds — and every cubic metre is accounted for.
    expect(json.inundation.maxDepthMetres).toBeGreaterThan(0)
    expect(json.inundation.floodedAreaKm2).toBeGreaterThan(0)
    expect(json.inundation.zones.length).toBeGreaterThan(0)
    const { generatedM3, pondedM3, drainedM3 } = json.inundation.volume
    expect(pondedM3 + drainedM3).toBeGreaterThan(generatedM3 * 0.999)
    expect(pondedM3 + drainedM3).toBeLessThan(generatedM3 * 1.001)

    for (const zone of json.inundation.zones) {
      expect(zone.kind.kind).toBe('scenario')
      expect(['Polygon', 'MultiPolygon']).toContain(zone.geometry.type)
    }
    expect(json.provenance.mode).toBe('fixture')
    expect(json.limitations.length).toBeGreaterThan(0)
  })
})

describe('POST /api/geo/inundation-estimate — live mode', () => {
  const liveEnv = { GEO_DATA_MODE: 'live' }
  const at = { latitude: 35.68, longitude: 139.77 }

  it('fetches Open-Meteo rainfall and Terrarium DEM tiles, and drains a flat plain dry', async () => {
    // Five sample points, each totalling 2 + 3 = 5 mm over the window.
    const openMeteo = JSON.stringify(
      Array.from({ length: 5 }, () => ({ hourly: { precipitation: [2, 3] } })),
    )
    const { app, proxy } = appWith(liveEnv, {
      jsonBody: openMeteo,
      tileBytes: terrariumTile(() => 100),
    })

    const res = await estimate(app, { at, radiusKm: 1, durationHours: 2 })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      precipitation: { rainfallMm: number; source: string }
      inundation: { floodedAreaKm2: number; volume: { generatedM3: number; drainedM3: number } }
      provenance: { mode: string }
    }

    expect(proxy.jsonUrls).toHaveLength(1)
    expect(proxy.jsonUrls[0]).toContain('api.open-meteo.com')
    expect(proxy.jsonUrls[0]).toContain('forecast_hours=2')
    expect(proxy.tileUrls.length).toBeGreaterThan(0)
    expect(proxy.tileUrls[0]).toContain('s3.amazonaws.com/elevation-tiles-prod/terrarium/')

    expect(json.precipitation.rainfallMm).toBeCloseTo(5, 5)
    // 5 mm on CN 80 is below the initial abstraction: nothing ponds anywhere,
    // and on a perfectly flat tile nothing could pond regardless.
    expect(json.inundation.floodedAreaKm2).toBe(0)
    expect(json.inundation.volume.drainedM3).toBe(json.inundation.volume.generatedM3)
    expect(json.provenance.mode).toBe('live')
  })

  it('serves a repeat of the same question from cache', async () => {
    const { app } = appWith(liveEnv, { tileBytes: terrariumTile(() => 100) })
    const body = { at, radiusKm: 1, rainfallMm: 80 }

    const first = await estimate(app, body)
    expect(first.status).toBe(200)
    expect(first.headers.get('x-cache-hit')).toBe('false')

    const second = await estimate(app, body)
    expect(second.status).toBe(200)
    expect(second.headers.get('x-cache-hit')).toBe('true')
    expect(await second.text()).toBe(await first.text())
  })

  it('answers 502 with advice when the precipitation feed is unreadable', async () => {
    const { app } = appWith(liveEnv, { jsonBody: 'not json at all' })
    const res = await estimate(app, { at, radiusKm: 1 })
    expect(res.status).toBe(502)
    const json = (await res.json()) as { error: string; message: string }
    expect(json.error).toBe('UpstreamFailed')
    expect(json.message).toContain('rainfallMm')
  })
})
