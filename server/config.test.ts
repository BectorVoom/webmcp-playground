import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { isHostAllowed, loadConfig } from './config'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

describe('loadConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = run(loadConfig({}))
    expect(config.llmBaseUrl).toBe('http://localhost:11434/v1')
    expect(config.llmTimeoutMs).toBe(120_000)
    expect(config.port).toBe(8787)
    expect(config.traceDir).toBe('.traces')

    // Disaster Safety defaults (R7.7)
    expect(config.geoDataMode).toBe('fixture')
    expect(config.routingBaseUrl).toBe('https://valhalla1.openstreetmap.de')
    expect(config.routingApiKey).toBeUndefined()
    expect(config.mapTileUrl).toBeUndefined()
    expect(config.mapTileKey).toBeUndefined()
    expect(config.geoCacheTtlAlertsMs).toBe(60_000)
    expect(config.geoCacheTtlFloodMs).toBe(600_000)
    expect(config.geoCacheTtlPlacesMs).toBe(86_400_000)
    expect(config.geoCacheTtlTilesMs).toBe(86_400_000)
    expect(config.geoTileCap).toBe(64)
    expect(config.geoTimeoutMs).toBe(8_000)
    expect(config.geoBreakerThreshold).toBe(5)
    expect(config.geoBreakerCooldownMs).toBe(60_000)
    expect(config.geoCoordPrecision).toBe(4)
    expect(config.geoTraceCoordPrecision).toBe(3)
    expect(config.geoAllowedHosts).toContain('api.weather.gov')
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
