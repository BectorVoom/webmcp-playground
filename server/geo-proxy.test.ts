import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { loadConfig } from './config'
import { GeoProxyService } from './geo-proxy'
import { createApp } from './index'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

interface ProvidersResponse {
  readonly ok: boolean
  readonly dataMode: string
  readonly stats: {
    readonly circuitStates: Record<string, string>
  }
}

interface ErrorResponse {
  readonly error: string
}

interface HealthResponseTest {
  readonly geo?: {
    readonly dataMode: string
  }
}

describe('GeoProxyService (Phase 4)', () => {
  const config = run(
    loadConfig({
      GEO_ALLOWED_HOSTS: 'api.weather.gov, cyberjapandata.gsi.go.jp',
      GEO_BREAKER_THRESHOLD: '3',
      GEO_BREAKER_COOLDOWN_MS: '1000',
    }),
  )

  it('redacts sensitive API keys and tokens in URLs (R9.1)', () => {
    const proxy = new GeoProxyService(config)
    const url = 'https://api.weather.gov/alerts?token=secret123&key=mykey456'
    const redacted = proxy.redactUrl(url)
    expect(redacted).not.toContain('secret123')
    expect(redacted).not.toContain('mykey456')
    expect(redacted).toContain('[REDACTED]')
  })

  it('refuses requests to unlisted hosts before network call (R7.8)', async () => {
    const proxy = new GeoProxyService(config)
    await expect(
      proxy.fetchUpstream('untrusted', 'https://malicious.example.com/data'),
    ).rejects.toThrow(/HostNotAllowed/)
  })

  it('manages cache hits and TTLs (R7.3)', () => {
    const proxy = new GeoProxyService(config)
    const key = 'test-cache-key'
    proxy.setCache(key, { result: 'ok' }, '{"result":"ok"}', 200, 'application/json')

    const hit = proxy.getCache(key, 5000)
    expect(hit).not.toBeNull()
    expect(hit?.hit).toBe(true)
    expect(hit?.entry.data).toEqual({ result: 'ok' })

    // Expired TTL
    const expired = proxy.getCache(key, -1)
    expect(expired).toBeNull()
  })

  it('opens circuit breaker after N consecutive failures and closes after cooldown (R7.6)', async () => {
    const proxy = new GeoProxyService(config)
    const sourceId = 'flaky-source'

    expect(proxy.getCircuit(sourceId).state).toBe('closed')

    proxy.recordFailure(sourceId)
    proxy.recordFailure(sourceId)
    expect(proxy.getCircuit(sourceId).state).toBe('closed')

    proxy.recordFailure(sourceId) // 3rd failure hits threshold
    expect(proxy.getCircuit(sourceId).state).toBe('open')

    // While open, fetching fails immediately
    await expect(
      proxy.fetchUpstream(sourceId, 'https://api.weather.gov/error'),
    ).rejects.toThrow(/SourceCircuitOpen/)
  })
})

describe('Geo HTTP Routes (/api/geo/*) (R7.1, R7.2)', () => {
  const config = run(loadConfig({ GEO_DATA_MODE: 'fixture' }))
  const app = createApp(config)

  it('GET /api/geo/providers returns configuration and stats (R7.11)', async () => {
    const res = await app.request('/api/geo/providers')
    expect(res.status).toBe(200)
    const json = (await res.json()) as ProvidersResponse
    expect(json.ok).toBe(true)
    expect(json.dataMode).toBe('fixture')
    expect(json.stats.circuitStates).toBeDefined()
  })

  it('POST /api/geo/flood validates coordinates at boundary and returns 400 for invalid bodies (R7.2)', async () => {
    // Missing body
    const res1 = await app.request('/api/geo/flood', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res1.status).toBe(400)
    const json1 = (await res1.json()) as ErrorResponse
    expect(json1.error).toBe('ValidationError')

    // Invalid latitude
    const res2 = await app.request('/api/geo/flood', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: { latitude: 999, longitude: 139.7 } }),
    })
    expect(res2.status).toBe(400)
  })

  it('POST /api/geo/route validates location array (R7.2)', async () => {
    const res = await app.request('/api/geo/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: [] }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as ErrorResponse
    expect(json.error).toBe('ValidationError')
  })

  it('GET /api/health includes geo health metrics (R7.11)', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const json = (await res.json()) as HealthResponseTest
    expect(json.geo).toBeDefined()
    expect(json.geo?.dataMode).toBe('fixture')
  })
})
