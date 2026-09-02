import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { describeMissingRoutingKey, isHostAllowed, loadConfig } from './config'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

describe('loadConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = run(loadConfig({}))
    expect(config.llmBaseUrl).toBe('http://localhost:11434/v1')
    expect(config.llmTimeoutMs).toBe(120_000)
    expect(config.hostname).toBe('127.0.0.1')
    expect(config.port).toBe(8787)
    expect(config.webMcpOriginTrialToken).toBeUndefined()
    expect(config.traceDir).toBe('.traces')

    // Disaster Safety defaults (R7.7)
    expect(config.geoDataMode).toBe('fixture')
    expect(config.routingBaseUrl).toBe('https://api.stadiamaps.com')
    expect(config.routingRoutePath).toBe('/route/v1')
    expect(config.routingApiKey).toBeUndefined()
    expect(config.mapTileUrl).toBeUndefined()
    expect(config.mapTileKey).toBeUndefined()
    expect(config.geoCacheTtlAlertsMs).toBe(60_000)
    expect(config.geoCacheTtlFloodMs).toBe(600_000)
    expect(config.geoCacheTtlPlacesMs).toBe(86_400_000)
    expect(config.geoCacheTtlGeocodeMs).toBe(86_400_000)
    expect(config.geoCacheTtlTilesMs).toBe(86_400_000)
    expect(config.geoTileCap).toBe(512)
    expect(config.geoTimeoutMs).toBe(8_000)
    expect(config.geoBreakerThreshold).toBe(5)
    expect(config.geoBreakerCooldownMs).toBe(60_000)
    expect(config.geoCoordPrecision).toBe(4)
    expect(config.geoTraceCoordPrecision).toBe(3)
    expect(config.geoAllowedHosts).toContain('api.weather.gov')
    // Same self-consistency rule as routing: the geocoder's host must be allowed by default, or
    // every place-name lookup is refused before it leaves the process.
    expect(config.geoAllowedHosts).toContain('nominatim.openstreetmap.org')
    // The routing host has to be on the allowlist or every route request is refused before it
    // leaves the process — a default that contradicts itself is worse than no default.
    expect(config.geoAllowedHosts).toContain('api.stadiamaps.com')
    expect(isHostAllowed(config.geoAllowedHosts, config.routingBaseUrl)).toBe(true)
  })

  it('names GEO_CACHE_TTL_GEOCODE_MS when its value is malformed', () => {
    const error = run(Effect.flip(loadConfig({ GEO_CACHE_TTL_GEOCODE_MS: 'a day' })))
    expect(error.variable).toBe('GEO_CACHE_TTL_GEOCODE_MS')
  })

  it('treats an empty string as unset rather than as a value', () => {
    expect(run(loadConfig({ LLM_API_KEY: '   ' })).llmApiKey).toBeUndefined()
  })

  it('strips a trailing slash so URL joining stays predictable', () => {
    expect(run(loadConfig({ LLM_BASE_URL: 'http://localhost:1234/v1/' })).llmBaseUrl).toBe(
      'http://localhost:1234/v1',
    )
  })

  it('names the offending variable when a number is malformed', () => {
    const error = run(Effect.flip(loadConfig({ LLM_TIMEOUT_MS: 'soon' })))
    expect(error._tag).toBe('ConfigError')
    expect(error.variable).toBe('LLM_TIMEOUT_MS')
    expect(error.expected).toContain('positive integer')
  })

  it('rejects a non-positive timeout instead of quietly accepting it', () => {
    expect(run(Effect.flip(loadConfig({ LLM_TIMEOUT_MS: '0' }))).variable).toBe('LLM_TIMEOUT_MS')
  })

  it('rejects a malformed base URL', () => {
    expect(run(Effect.flip(loadConfig({ LLM_BASE_URL: 'localhost:11434' }))).variable).toBe(
      'LLM_BASE_URL',
    )
  })

  it('accepts only true or false for a boolean flag', () => {
    expect(run(loadConfig({ TRACE_WRITE_ENABLED: 'false' })).traceWriteEnabled).toBe(false)
    expect(run(Effect.flip(loadConfig({ TRACE_WRITE_ENABLED: 'yes' }))).variable).toBe(
      'TRACE_WRITE_ENABLED',
    )
  })

  it('accepts a production bind address and WebMCP Origin Trial token', () => {
    const config = run(
      loadConfig({ HOST: '0.0.0.0', WEBMCP_ORIGIN_TRIAL_TOKEN: 'public-token==' }),
    )
    expect(config.hostname).toBe('0.0.0.0')
    expect(config.webMcpOriginTrialToken).toBe('public-token==')
  })

  it('rejects response-header injection in the Origin Trial token', () => {
    const error = run(
      Effect.flip(loadConfig({ WEBMCP_ORIGIN_TRIAL_TOKEN: 'token\r\nx-injected: yes' })),
    )
    expect(error.variable).toBe('WEBMCP_ORIGIN_TRIAL_TOKEN')
    expect(error.expected).toContain('single-line')
  })

  it('rejects a URL where HOST requires only a bind address', () => {
    expect(run(Effect.flip(loadConfig({ HOST: 'https://example.com' }))).variable).toBe('HOST')
  })

  it('rejects an invalid GEO_DATA_MODE', () => {
    const error = run(Effect.flip(loadConfig({ GEO_DATA_MODE: 'invalid' })))
    expect(error.variable).toBe('GEO_DATA_MODE')
    expect(error.expected).toContain('"live" or "fixture"')
  })

  it('parses GEO_ALLOWED_HOSTS and verifies allowlist enforcement (R7.8)', () => {
    const config = run(loadConfig({ GEO_ALLOWED_HOSTS: 'api.weather.gov, cyberjapandata.gsi.go.jp' }))
    expect(config.geoAllowedHosts).toEqual(['api.weather.gov', 'cyberjapandata.gsi.go.jp'])

    expect(isHostAllowed(config.geoAllowedHosts, 'https://api.weather.gov/alerts')).toBe(true)
    expect(isHostAllowed(config.geoAllowedHosts, 'cyberjapandata.gsi.go.jp')).toBe(true)
    expect(isHostAllowed(config.geoAllowedHosts, 'https://evil.com/payload')).toBe(false)
    expect(isHostAllowed(config.geoAllowedHosts, 'google.com')).toBe(false)
  })
})

describe('warning about a missing routing key', () => {
  it('names the variable when live routing meets a host that needs one', () => {
    const config = run(loadConfig({ ROUTING_MODE: 'live' }))
    const warning = describeMissingRoutingKey(config)

    expect(warning).toContain('ROUTING_API_KEY')
    expect(warning).toContain('api.stadiamaps.com')
  })

  it('says nothing when routing is on recordings, where no request is made at all', () => {
    expect(describeMissingRoutingKey(run(loadConfig({ ROUTING_MODE: 'fixture' })))).toBeNull()
  })

  it('says nothing once a key is set', () => {
    const config = run(loadConfig({ ROUTING_MODE: 'live', ROUTING_API_KEY: 'k' }))
    expect(describeMissingRoutingKey(config)).toBeNull()
  })

  it('says nothing about a self-hosted engine, which needs no key', () => {
    const config = run(
      loadConfig({
        ROUTING_MODE: 'live',
        ROUTING_BASE_URL: 'http://localhost:8002',
        ROUTING_ROUTE_PATH: '/route',
        GEO_ALLOWED_HOSTS: 'localhost',
      }),
    )
    expect(describeMissingRoutingKey(config)).toBeNull()
  })
})

/**
 * Routing has a mode of its own because the recorded replies only cover the one place they were
 * captured at. Tying it to GEO_DATA_MODE left the default install drawing no routes anywhere but
 * that place — a map that looks broken, with nothing saying why.
 */
describe('resolving the routing mode', () => {
  it('routes live on a key, even while the hazard data stays simulated', () => {
    const config = run(loadConfig({ GEO_DATA_MODE: 'fixture', ROUTING_API_KEY: 'k' }))
    expect(config.geoDataMode).toBe('fixture')
    expect(config.routingMode).toBe('live')
  })

  it('falls back to the recordings when there is no engine it could call', () => {
    expect(run(loadConfig({})).routingMode).toBe('fixture')
  })

  it('routes live against an engine that needs no key', () => {
    const config = run(
      loadConfig({ ROUTING_BASE_URL: 'http://localhost:8002', GEO_ALLOWED_HOSTS: 'localhost' }),
    )
    expect(config.routingMode).toBe('live')
  })

  it('honours an explicit choice over what it could work out', () => {
    expect(run(loadConfig({ ROUTING_MODE: 'fixture', ROUTING_API_KEY: 'k' })).routingMode).toBe(
      'fixture',
    )
    expect(run(loadConfig({ ROUTING_MODE: 'live' })).routingMode).toBe('live')
  })

  it('refuses a mode it does not recognise rather than guessing', () => {
    const failure = Effect.runSync(Effect.either(loadConfig({ ROUTING_MODE: 'sometimes' })))
    expect(failure._tag).toBe('Left')
    if (failure._tag !== 'Left') return
    expect(failure.left.variable).toBe('ROUTING_MODE')
  })
})
