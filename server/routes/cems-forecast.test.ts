import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { GeoProxyService } from '../geo-proxy'
import { cemsForecastRoutes } from './cems-forecast'

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cems-route-'))
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

/**
 * Answers every store call with a job that never finishes, so the route's own behaviour — its
 * validation, its fixture gate and its "not ready" reply — can be tested without standing up the
 * whole retrieval. The retrieval itself is covered in `server/cems/glofas-service.test.ts`.
 */
class QueuedStore extends GeoProxyService {
  override async fetchUpstream(_sourceId: string, targetUrl: string) {
    const body = targetUrl.includes('/execution')
      ? { jobID: 'job-1', status: 'accepted' }
      : { status: 'running' }
    return {
      status: 200,
      body: JSON.stringify(body),
      contentType: 'application/json',
      redactedUrl: targetUrl,
    }
  }
}

const token = { apiUrl: 'https://ewds.climate.copernicus.eu/api', key: 'test-token', keySource: 'test' }

const appWith = (env: Record<string, string | undefined>, credentials = token as typeof token | undefined) => {
  const config = { ...Effect.runSync(loadConfig(env)), cemsCacheDir: cacheDir }
  const app = new Hono()
  app.route('/api/geo', cemsForecastRoutes(config, new QueuedStore(config), { credentials }))
  return app
}

const post = (app: Hono, body: unknown) =>
  app.request('/api/geo/cems-forecast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const live = { GEO_DATA_MODE: 'live' }

/** No token, spelled out rather than defaulted — passing `undefined` would select the default. */
const unconfigured = () => {
  const config = { ...Effect.runSync(loadConfig(live)), cemsCacheDir: cacheDir }
  const app = new Hono()
  app.route('/api/geo', cemsForecastRoutes(config, new QueuedStore(config), {}))
  return app
}

describe('POST /api/geo/cems-forecast', () => {
  it('rejects a malformed body', async () => {
    const app = appWith(live)
    const res = await app.request('/api/geo/cems-forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('rejects coordinates that are not coordinates', async () => {
    const app = appWith(live)
    expect((await post(app, {})).status).toBe(400)
    expect((await post(app, { at: { latitude: 91, longitude: 0 } })).status).toBe(400)
    expect((await post(app, { at: { latitude: 0, longitude: 181 } })).status).toBe(400)
    expect((await post(app, { at: { latitude: 'north', longitude: 0 } })).status).toBe(400)
  })

  /** Fixture mode never calls out, exactly as every other geo route behaves. */
  it('does not retrieve in fixture mode, and says why rather than drawing nothing', async () => {
    const res = await post(appWith({ GEO_DATA_MODE: 'fixture' }), {
      at: { latitude: 50.94, longitude: 6.96 },
    })
    const body = (await res.json()) as { mode: string; state: string; detail: string; zones: [] }

    expect(res.status).toBe(200)
    expect(body.mode).toBe('fixture')
    expect(body.state).toBe('unconfigured')
    expect(body.detail).toContain('no recorded GloFAS ensemble')
    expect(body.zones).toEqual([])
  })

  /**
   * 202, not 200: a queued retrieval is temporary and worth asking about again, and a 200 with an
   * empty zone list is indistinguishable from "nothing here will flood".
   */
  it('answers 202 while the retrieval is still queued', async () => {
    const res = await post(appWith(live), { at: { latitude: 50.94, longitude: 6.96 } })
    const body = (await res.json()) as {
      state: string
      detail: string
      progress: { thresholdChunksTotal: number }
      zones: []
    }

    expect(res.status).toBe(202)
    expect(body.state).toBe('pending')
    expect(body.detail).toContain('queued jobs')
    expect(body.progress.thresholdChunksTotal).toBeGreaterThan(0)
    expect(body.zones).toEqual([])
  })

  it('reports an unconfigured token as settled rather than pending', async () => {
    const res = await post(unconfigured(), { at: { latitude: 50.94, longitude: 6.96 } })
    const body = (await res.json()) as { state: string; detail: string }

    // 200, because retrying will not help until somebody sets a variable.
    expect(res.status).toBe(200)
    expect(body.state).toBe('unconfigured')
    expect(body.detail).toContain('CEMS_API_KEY')
  })

  it('defaults the radius rather than retrieving a degenerate box', async () => {
    const res = await post(appWith(live), { at: { latitude: 50.94, longitude: 6.96 }, radiusKm: -5 })
    expect(res.status).toBe(202)
  })
})
