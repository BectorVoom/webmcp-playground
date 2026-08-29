import { Effect, Schema } from 'effect'
import { ConfigError } from '../src/domain/errors'

/**
 * Configuration is read once, at startup, and a malformed value stops the
 * process with the variable named (R8.5). The alternative — a NaN timeout that
 * surfaces three layers down as a confusing fetch error — is exactly the kind
 * of debugging tax this project exists to avoid.
 */

export interface ServerConfig {
  readonly llmBaseUrl: string
  readonly llmApiKey: string | undefined
  readonly llmDefaultModel: string | undefined
  readonly llmTimeoutMs: number
  readonly port: number
  readonly traceDir: string
  readonly traceWriteEnabled: boolean

  // Disaster Safety Tool Set (Design §10.1)
  readonly geoDataMode: 'live' | 'fixture'
  readonly geoAllowedHosts: ReadonlyArray<string>
  readonly routingBaseUrl: string
  readonly routingApiKey: string | undefined
  readonly mapTileUrl: string | undefined
  readonly mapTileKey: string | undefined
  readonly geoCacheTtlAlertsMs: number
  readonly geoCacheTtlFloodMs: number
  readonly geoCacheTtlPlacesMs: number
  readonly geoCacheTtlTilesMs: number
  readonly geoTileCap: number
  readonly geoTimeoutMs: number
  readonly geoBreakerThreshold: number
  readonly geoBreakerCooldownMs: number
  readonly geoCoordPrecision: number
  readonly geoTraceCoordPrecision: number
}

const DEFAULTS = {
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_TIMEOUT_MS: '120000',
  PORT: '8787',
  TRACE_DIR: '.traces',
  TRACE_WRITE_ENABLED: 'true',

  GEO_DATA_MODE: 'fixture',
  GEO_ALLOWED_HOSTS:
    'api.weather.gov,hazards.fema.gov,gis.fema.gov,cyberjapandata.gsi.go.jp,www.jma.go.jp,emergency.copernicus.eu,overpass-api.de,feeds.meteoalarm.org,valhalla1.openstreetmap.de',
  ROUTING_BASE_URL: 'https://valhalla1.openstreetmap.de',
  GEO_CACHE_TTL_ALERTS_MS: '60000',
  GEO_CACHE_TTL_FLOOD_MS: '600000',
  GEO_CACHE_TTL_PLACES_MS: '86400000',
  GEO_CACHE_TTL_TILES_MS: '86400000',
  GEO_TILE_CAP: '64',
  GEO_TIMEOUT_MS: '8000',
  GEO_BREAKER_THRESHOLD: '5',
  GEO_BREAKER_COOLDOWN_MS: '60000',
  GEO_COORD_PRECISION: '4',
  GEO_TRACE_COORD_PRECISION: '3',
} as const

const PositiveInt = Schema.NumberFromString.pipe(Schema.int(), Schema.positive())

const decodePositiveInt = (
  variable: string,
  raw: string,
): Effect.Effect<number, ConfigError> =>
  Schema.decodeUnknown(PositiveInt)(raw).pipe(
    Effect.mapError(() => new ConfigError({ variable, value: raw, expected: 'a positive integer' })),
  )

const decodeUrl = (variable: string, raw: string): Effect.Effect<string, ConfigError> =>
  Effect.try({
    try: () => new URL(raw),
    catch: () => new ConfigError({ variable, value: raw, expected: 'an absolute http(s) URL' }),
  }).pipe(
    Effect.filterOrFail(
      (url) => url.protocol === 'http:' || url.protocol === 'https:',
      () => new ConfigError({ variable, value: raw, expected: 'an absolute http(s) URL' }),
    ),
    Effect.map((url) => url.toString().replace(/\/$/, '')),
  )

const decodeBoolean = (variable: string, raw: string): Effect.Effect<boolean, ConfigError> =>
  raw === 'true' || raw === 'false'
    ? Effect.succeed(raw === 'true')
    : Effect.fail(new ConfigError({ variable, value: raw, expected: '"true" or "false"' }))

const decodeDataMode = (
  variable: string,
  raw: string,
): Effect.Effect<'live' | 'fixture', ConfigError> =>
  raw === 'live' || raw === 'fixture'
    ? Effect.succeed(raw)
    : Effect.fail(new ConfigError({ variable, value: raw, expected: '"live" or "fixture"' }))

const decodeHosts = (
  variable: string,
  raw: string,
): Effect.Effect<ReadonlyArray<string>, ConfigError> => {
  const list = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  if (list.length === 0) {
    return Effect.fail(
      new ConfigError({ variable, value: raw, expected: 'a comma-separated list of hostnames' }),
    )
  }
  return Effect.succeed(list)
}

const optional = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim() === '' ? undefined : raw

export const isHostAllowed = (allowedHosts: ReadonlyArray<string>, urlOrHost: string): boolean => {
  try {
    const hostname = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : urlOrHost
    return allowedHosts.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    )
  } catch {
    return false
  }
}

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<ServerConfig, ConfigError> =>
  Effect.gen(function* () {
    const llmBaseUrl = yield* decodeUrl('LLM_BASE_URL', env.LLM_BASE_URL ?? DEFAULTS.LLM_BASE_URL)
    const llmTimeoutMs = yield* decodePositiveInt(
      'LLM_TIMEOUT_MS',
      env.LLM_TIMEOUT_MS ?? DEFAULTS.LLM_TIMEOUT_MS,
    )
    const port = yield* decodePositiveInt('PORT', env.PORT ?? DEFAULTS.PORT)
    const traceWriteEnabled = yield* decodeBoolean(
      'TRACE_WRITE_ENABLED',
      env.TRACE_WRITE_ENABLED ?? DEFAULTS.TRACE_WRITE_ENABLED,
    )

    // Geo config
    const geoDataMode = yield* decodeDataMode(
      'GEO_DATA_MODE',
      env.GEO_DATA_MODE ?? DEFAULTS.GEO_DATA_MODE,
    )
    const geoAllowedHosts = yield* decodeHosts(
      'GEO_ALLOWED_HOSTS',
      env.GEO_ALLOWED_HOSTS ?? DEFAULTS.GEO_ALLOWED_HOSTS,
    )
    const routingBaseUrl = yield* decodeUrl(
      'ROUTING_BASE_URL',
      env.ROUTING_BASE_URL ?? DEFAULTS.ROUTING_BASE_URL,
    )
    const geoCacheTtlAlertsMs = yield* decodePositiveInt(
      'GEO_CACHE_TTL_ALERTS_MS',
      env.GEO_CACHE_TTL_ALERTS_MS ?? DEFAULTS.GEO_CACHE_TTL_ALERTS_MS,
    )
    const geoCacheTtlFloodMs = yield* decodePositiveInt(
      'GEO_CACHE_TTL_FLOOD_MS',
      env.GEO_CACHE_TTL_FLOOD_MS ?? DEFAULTS.GEO_CACHE_TTL_FLOOD_MS,
    )
    const geoCacheTtlPlacesMs = yield* decodePositiveInt(
      'GEO_CACHE_TTL_PLACES_MS',
      env.GEO_CACHE_TTL_PLACES_MS ?? DEFAULTS.GEO_CACHE_TTL_PLACES_MS,
    )
    const geoCacheTtlTilesMs = yield* decodePositiveInt(
      'GEO_CACHE_TTL_TILES_MS',
      env.GEO_CACHE_TTL_TILES_MS ?? DEFAULTS.GEO_CACHE_TTL_TILES_MS,
    )
    const geoTileCap = yield* decodePositiveInt(
      'GEO_TILE_CAP',
      env.GEO_TILE_CAP ?? DEFAULTS.GEO_TILE_CAP,
    )
    const geoTimeoutMs = yield* decodePositiveInt(
      'GEO_TIMEOUT_MS',
      env.GEO_TIMEOUT_MS ?? DEFAULTS.GEO_TIMEOUT_MS,
    )
    const geoBreakerThreshold = yield* decodePositiveInt(
      'GEO_BREAKER_THRESHOLD',
      env.GEO_BREAKER_THRESHOLD ?? DEFAULTS.GEO_BREAKER_THRESHOLD,
    )
    const geoBreakerCooldownMs = yield* decodePositiveInt(
      'GEO_BREAKER_COOLDOWN_MS',
      env.GEO_BREAKER_COOLDOWN_MS ?? DEFAULTS.GEO_BREAKER_COOLDOWN_MS,
    )
    const geoCoordPrecision = yield* decodePositiveInt(
      'GEO_COORD_PRECISION',
      env.GEO_COORD_PRECISION ?? DEFAULTS.GEO_COORD_PRECISION,
    )
    const geoTraceCoordPrecision = yield* decodePositiveInt(
      'GEO_TRACE_COORD_PRECISION',
      env.GEO_TRACE_COORD_PRECISION ?? DEFAULTS.GEO_TRACE_COORD_PRECISION,
    )

    return {
      llmBaseUrl,
      llmApiKey: optional(env.LLM_API_KEY),
      llmDefaultModel: optional(env.LLM_DEFAULT_MODEL),
      llmTimeoutMs,
      port,
      traceDir: optional(env.TRACE_DIR) ?? DEFAULTS.TRACE_DIR,
      traceWriteEnabled,

      geoDataMode,
      geoAllowedHosts,
      routingBaseUrl,
      routingApiKey: optional(env.ROUTING_API_KEY),
      mapTileUrl: optional(env.MAP_TILE_URL),
      mapTileKey: optional(env.MAP_TILE_KEY),
      geoCacheTtlAlertsMs,
      geoCacheTtlFloodMs,
      geoCacheTtlPlacesMs,
      geoCacheTtlTilesMs,
      geoTileCap,
      geoTimeoutMs,
      geoBreakerThreshold,
      geoBreakerCooldownMs,
      geoCoordPrecision,
      geoTraceCoordPrecision,
    }
  })
