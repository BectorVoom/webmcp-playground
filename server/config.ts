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
  /** Interface to bind. Keep loopback for local work; production containers normally use 0.0.0.0. */
  readonly hostname: string
  readonly port: number
  /** Public Chrome Origin Trial token. It is delivered as a response header, never bundled into JS. */
  readonly webMcpOriginTrialToken: string | undefined
  readonly traceDir: string
  readonly traceWriteEnabled: boolean
  /**
   * Where the fitted ERA5 rainfall climatology is kept between runs. Empty
   * disables it and every restart re-asks the archive, which its daily request
   * cap does not forgive.
   */
  readonly climateCacheDir: string
  /**
   * Where mapped embankments are kept between runs. Overpass is a free
   * community service that answers a 20 km box with megabytes and rate-limits
   * under load, and an outage silently reports the floodplain as undefended.
   * Empty disables the store and every restart re-asks.
   */
  readonly leveeCacheDir: string
  /**
   * Where decoded DEM tiles are kept between runs. Elevation tiles are static in
   * a way almost nothing else here is — the ground does not move between
   * requests — so a tile is worth fetching once per machine.
   *
   * Empty disables it, and empty is the default. Unlike the climatology and
   * embankment stores, this one is keyed by tile coordinate alone and so will
   * answer *any* caller asking for that ground, including a test that stubbed
   * its upstream with a synthetic hillside and never expected real terrain
   * back. A store that can satisfy a request the proxy never sees has to be
   * opted into rather than inherited.
   */
  readonly demCacheDir: string
  /**
   * Where mapped standing water is kept between runs. Same upstream and same
   * bargain as the embankments: Overpass is free, slow and rate-limited, and
   * lakes do not move.
   */
  readonly waterCacheDir: string
  /**
   * Where Copernicus flood retrievals are kept between runs. The store answers
   * a request as a queued job rather than a reply, and the thirty years of
   * history a location's flood thresholds are fitted from is six such jobs. It
   * is asked for once per place, ever. Empty disables the store, which disables
   * the European forecast with it — there would be nowhere to put the answer.
   */
  readonly cemsCacheDir: string

  // Disaster Safety Tool Set (Design §10.1)
  readonly geoDataMode: 'live' | 'fixture'
  readonly geoAllowedHosts: ReadonlyArray<string>
  readonly routingBaseUrl: string
  /**
   * Path of the route endpoint on that host. Stadia Maps serves `/route/v1`; a bare Valhalla
   * serves `/route`. Hardcoding either would 404 silently against the other.
   */
  readonly routingRoutePath: string
  readonly routingApiKey: string | undefined
  /**
   * Whether routing goes to the live engine, resolved from `ROUTING_MODE`.
   *
   * Deliberately not tied to `GEO_DATA_MODE`. Flood zones and shelters can be simulated because a
   * simulated one is still shaped like the real thing; a route cannot, because a path that does
   * not follow streets is not a route at all. Recorded replies only cover the place they were
   * captured, so tying the two together left the map drawing no routes anywhere else — which is
   * what fixture mode did before this existed.
   */
  readonly routingMode: 'live' | 'fixture'
  readonly mapTileUrl: string | undefined
  readonly mapTileKey: string | undefined
  readonly geoCacheTtlAlertsMs: number
  readonly geoCacheTtlFloodMs: number
  readonly geoCacheTtlPlacesMs: number
  readonly geoCacheTtlGeocodeMs: number
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
  HOST: '127.0.0.1',
  PORT: '8787',
  TRACE_DIR: '.traces',
  TRACE_WRITE_ENABLED: 'true',
  CLIMATE_CACHE_DIR: '.cache/era5',
  LEVEE_CACHE_DIR: '.cache/osm-levees',
  DEM_CACHE_DIR: '',
  WATER_CACHE_DIR: '.cache/osm-water',
  CEMS_CACHE_DIR: '.cache/cems',

  GEO_DATA_MODE: 'fixture',
  // `ewds.climate.copernicus.eu` is the ECMWF Data Store, which is where CEMS-Flood moved to and
  // the only catalogue carrying the GloFAS forecast; `os-api.cci2.ecmwf.int` is the object store a
  // finished retrieval is collected from, and a download that cannot reach it is a job that ran
  // for nothing.
  GEO_ALLOWED_HOSTS:
    'api.weather.gov,hazards.fema.gov,gis.fema.gov,cyberjapandata.gsi.go.jp,disaportaldata.gsi.go.jp,www.jma.go.jp,emergency.copernicus.eu,overpass-api.de,lambert.openstreetmap.de,overpass.private.coffee,feeds.meteoalarm.org,api.stadiamaps.com,api-eu.stadiamaps.com,valhalla1.openstreetmap.de,nominatim.openstreetmap.org,ows.globalfloods.eu,s3.amazonaws.com,api.open-meteo.com,archive-api.open-meteo.com,ewds.climate.copernicus.eu,cds.climate.copernicus.eu,os-api.cci2.ecmwf.int',
  // Stadia Maps runs Valhalla on OSM data, so the request and reply shapes are Valhalla's; what
  // it adds over the public demo server is an SLA and a rate limit worth planning an evacuation
  // against. The keyless demo host stays on the allowlist so it can be pointed back at.
  ROUTING_BASE_URL: 'https://api.stadiamaps.com',
  ROUTING_ROUTE_PATH: '/route/v1',
  ROUTING_MODE: 'auto',
  GEO_CACHE_TTL_ALERTS_MS: '60000',
  GEO_CACHE_TTL_FLOOD_MS: '600000',
  GEO_CACHE_TTL_PLACES_MS: '86400000',
  // A day, like places: a station moves on the timescale of a construction project, and
  // Nominatim's usage policy asks callers not to re-ask what they already know.
  GEO_CACHE_TTL_GEOCODE_MS: '86400000',
  GEO_CACHE_TTL_TILES_MS: '86400000',
  // Enough to cover the widest query the tools allow (20 km needs 441 tiles at z14). It was 64,
  // which examined 15% of that circle and left the rest unmapped.
  GEO_TILE_CAP: '512',
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

/**
 * Whether the configured engine can actually be called. Stadia rejects a keyless request, so a
 * key is what makes it usable; anything else — a self-hosted Valhalla, most obviously — is
 * assumed to need none, because it usually does not.
 */
const routingEngineUsable = (baseUrl: string, apiKey: string | undefined): boolean => {
  if (apiKey !== undefined) return true
  try {
    return !new URL(baseUrl).hostname.endsWith('stadiamaps.com')
  } catch {
    return false
  }
}

/**
 * `auto` — the default — routes live wherever there is an engine to route with, and falls back to
 * the recordings when there is not. `fixture` forces the recordings, which is the setting for a
 * demo that must not touch the network at all; `live` forces the engine and lets it fail loudly
 * rather than quietly serving recordings.
 */
const decodeRoutingMode = (
  variable: string,
  raw: string,
  baseUrl: string,
  apiKey: string | undefined,
): Effect.Effect<'live' | 'fixture', ConfigError> => {
  if (raw === 'live' || raw === 'fixture') return Effect.succeed(raw)
  if (raw === 'auto') {
    return Effect.succeed(routingEngineUsable(baseUrl, apiKey) ? 'live' : 'fixture')
  }
  return Effect.fail(
    new ConfigError({ variable, value: raw, expected: '"auto", "live" or "fixture"' }),
  )
}

/** A leading slash and no query string: the base URL owns the host, this owns the path. */
const decodePath = (variable: string, raw: string): Effect.Effect<string, ConfigError> =>
  raw.startsWith('/') && !raw.includes('?')
    ? Effect.succeed(raw.replace(/\/$/, ''))
    : Effect.fail(
        new ConfigError({ variable, value: raw, expected: 'a path beginning with "/", with no query string' }),
      )

const decodeBoolean = (variable: string, raw: string): Effect.Effect<boolean, ConfigError> =>
  raw === 'true' || raw === 'false'
    ? Effect.succeed(raw === 'true')
    : Effect.fail(new ConfigError({ variable, value: raw, expected: '"true" or "false"' }))

const decodeHostname = (variable: string, raw: string): Effect.Effect<string, ConfigError> => {
  const hostname = raw.trim()
  return hostname !== '' && !/[\s/\\]/.test(hostname)
    ? Effect.succeed(hostname)
    : Effect.fail(
        new ConfigError({
          variable,
          value: raw,
          expected: 'a hostname or bind address such as "127.0.0.1" or "0.0.0.0"',
        }),
      )
}

/** Values used as response headers must be one line; reject injection at startup, not per request. */
const decodeOptionalHeader = (
  variable: string,
  raw: string | undefined,
): Effect.Effect<string | undefined, ConfigError> => {
  const value = optional(raw)
  return value === undefined || (!value.includes('\r') && !value.includes('\n'))
    ? Effect.succeed(value)
    : Effect.fail(
        new ConfigError({ variable, value: raw ?? '', expected: 'a single-line header value' }),
      )
}

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

/**
 * The one configuration mistake that leaves a working server failing a request at a time: live
 * mode against a host that needs a key, with no key. Returned rather than logged so it can be
 * tested, and so a caller decides where a warning belongs.
 */
export const describeMissingRoutingKey = (config: ServerConfig): string | null => {
  if (config.routingMode !== 'live' || config.routingApiKey !== undefined) return null

  let host: string
  try {
    host = new URL(config.routingBaseUrl).hostname
  } catch {
    return null
  }
  // Only for hosts known to require one; a self-hosted Valhalla is perfectly happy without.
  if (!host.endsWith('stadiamaps.com')) return null

  return (
    `GEO_DATA_MODE=live but ROUTING_API_KEY is unset; ${host} will reject every route request ` +
    'and routing will fall back to recorded replies. Get a key at https://client.stadiamaps.com/'
  )
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
    const hostname = yield* decodeHostname('HOST', env.HOST ?? DEFAULTS.HOST)
    const port = yield* decodePositiveInt('PORT', env.PORT ?? DEFAULTS.PORT)
    const webMcpOriginTrialToken = yield* decodeOptionalHeader(
      'WEBMCP_ORIGIN_TRIAL_TOKEN',
      env.WEBMCP_ORIGIN_TRIAL_TOKEN,
    )
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
    const routingRoutePath = yield* decodePath(
      'ROUTING_ROUTE_PATH',
      env.ROUTING_ROUTE_PATH ?? DEFAULTS.ROUTING_ROUTE_PATH,
    )
    const routingApiKey = optional(env.ROUTING_API_KEY)
    const routingMode = yield* decodeRoutingMode(
      'ROUTING_MODE',
      env.ROUTING_MODE ?? DEFAULTS.ROUTING_MODE,
      routingBaseUrl,
      routingApiKey,
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
    const geoCacheTtlGeocodeMs = yield* decodePositiveInt(
      'GEO_CACHE_TTL_GEOCODE_MS',
      env.GEO_CACHE_TTL_GEOCODE_MS ?? DEFAULTS.GEO_CACHE_TTL_GEOCODE_MS,
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
      hostname,
      port,
      webMcpOriginTrialToken,
      traceDir: optional(env.TRACE_DIR) ?? DEFAULTS.TRACE_DIR,
      traceWriteEnabled,
      climateCacheDir: env.CLIMATE_CACHE_DIR ?? DEFAULTS.CLIMATE_CACHE_DIR,
      leveeCacheDir: env.LEVEE_CACHE_DIR ?? DEFAULTS.LEVEE_CACHE_DIR,
      demCacheDir: env.DEM_CACHE_DIR ?? DEFAULTS.DEM_CACHE_DIR,
      waterCacheDir: env.WATER_CACHE_DIR ?? DEFAULTS.WATER_CACHE_DIR,
      cemsCacheDir: env.CEMS_CACHE_DIR ?? DEFAULTS.CEMS_CACHE_DIR,

      geoDataMode,
      geoAllowedHosts,
      routingBaseUrl,
      routingRoutePath,
      routingApiKey,
      routingMode,
      mapTileUrl: optional(env.MAP_TILE_URL),
      mapTileKey: optional(env.MAP_TILE_KEY),
      geoCacheTtlAlertsMs,
      geoCacheTtlFloodMs,
      geoCacheTtlPlacesMs,
      geoCacheTtlGeocodeMs,
      geoCacheTtlTilesMs,
      geoTileCap,
      geoTimeoutMs,
      geoBreakerThreshold,
      geoBreakerCooldownMs,
      geoCoordPrecision,
      geoTraceCoordPrecision,
    }
  })
