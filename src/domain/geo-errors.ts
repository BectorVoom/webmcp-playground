import { Data } from 'effect'
import type { LonLat } from './geo'

/**
 * Tagged errors for Disaster Safety / Geo tools (Design §11, R8.9).
 * Every tagged error carries remedy hints for the UI/model.
 * Note: `NoDataCoverage` is intentionally NOT an error — it is a domain value on `Coverage` (ADR-3).
 */

export class GeolocationDenied extends Data.TaggedError('GeolocationDenied')<{
  readonly message?: string
}> {}

export class GeolocationUnavailable extends Data.TaggedError('GeolocationUnavailable')<{
  readonly message: string
}> {}

export class GeolocationTimeout extends Data.TaggedError('GeolocationTimeout')<{
  readonly timeoutMs: number
}> {}

export class InsecureContext extends Data.TaggedError('InsecureContext')<{
  readonly origin: string
}> {}

export class RegionUnsupported extends Data.TaggedError('RegionUnsupported')<{
  readonly coordinates: LonLat
  readonly supportedRegions: ReadonlyArray<string>
}> {}

export class SourceUnavailable extends Data.TaggedError('SourceUnavailable')<{
  readonly sourceId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class SourceRateLimited extends Data.TaggedError('SourceRateLimited')<{
  readonly sourceId: string
  readonly resetAt?: number
}> {}

export class SourceCircuitOpen extends Data.TaggedError('SourceCircuitOpen')<{
  readonly sourceId: string
  readonly cooldownMs: number
}> {}

export class UpstreamPayloadInvalid extends Data.TaggedError('UpstreamPayloadInvalid')<{
  readonly sourceId: string
  readonly path: string
  readonly expected?: string
  readonly excerpt?: string
}> {}

export class UpstreamTooLarge extends Data.TaggedError('UpstreamTooLarge')<{
  readonly sourceId: string
  readonly bytes: number
  readonly cap: number
}> {}

export class HostNotAllowed extends Data.TaggedError('HostNotAllowed')<{
  readonly host: string
}> {}

export class TileAnalysisFailed extends Data.TaggedError('TileAnalysisFailed')<{
  readonly tile: string
  readonly stage: string
  readonly message?: string
}> {}

export class RoutingUnavailable extends Data.TaggedError('RoutingUnavailable')<{
  readonly engine: string
  readonly message: string
}> {}

export class RouteNotFound extends Data.TaggedError('RouteNotFound')<{
  readonly destinationId: string
  readonly message?: string
}> {}

export type GeoError =
  | GeolocationDenied
  | GeolocationUnavailable
  | GeolocationTimeout
  | InsecureContext
  | RegionUnsupported
  | SourceUnavailable
  | SourceRateLimited
  | SourceCircuitOpen
  | UpstreamPayloadInvalid
  | UpstreamTooLarge
  | HostNotAllowed
  | TileAnalysisFailed
  | RoutingUnavailable
  | RouteNotFound

export const describeGeoError = (error: GeoError): string => {
  switch (error._tag) {
    case 'GeolocationDenied':
      return 'Location access was denied by the user or browser.'
    case 'GeolocationUnavailable':
      return `Location is unavailable: ${error.message}`
    case 'GeolocationTimeout':
      return `Geolocation timed out after ${error.timeoutMs} ms.`
    case 'InsecureContext':
      return `Geolocation is disabled in insecure context (${error.origin}).`
    case 'RegionUnsupported':
      return `Location (${error.coordinates.latitude.toFixed(4)}, ${error.coordinates.longitude.toFixed(4)}) is outside supported regions (${error.supportedRegions.join(', ')}). No provider was consulted.`
    case 'SourceUnavailable':
      return `Data source "${error.sourceId}" is unavailable: ${error.message}`
    case 'SourceRateLimited':
      return `Data source "${error.sourceId}" rate limit exceeded.`
    case 'SourceCircuitOpen':
      return `Data source "${error.sourceId}" circuit breaker is open (cooldown: ${error.cooldownMs} ms).`
    case 'UpstreamPayloadInvalid':
      return `Upstream payload from "${error.sourceId}" is invalid at path "${error.path}".`
    case 'UpstreamTooLarge':
      return `Upstream response from "${error.sourceId}" exceeded size cap (${error.bytes} > ${error.cap} bytes).`
    case 'HostNotAllowed':
      return `Outbound request to unlisted host "${error.host}" was refused.`
    case 'TileAnalysisFailed':
      return `Raster tile analysis failed for tile "${error.tile}" at stage "${error.stage}".`
    case 'RoutingUnavailable':
      return `Routing engine "${error.engine}" is unavailable: ${error.message}`
    case 'RouteNotFound':
      return `No route could be found to destination "${error.destinationId}".`
  }
}

export const remedyForGeoError = (error: GeoError): string => {
  switch (error._tag) {
    case 'GeolocationDenied':
      return 'Allow location access in browser settings, or pass explicit coordinates to the tool.'
    case 'GeolocationUnavailable':
      return 'Pass explicit latitude and longitude coordinates to the tool.'
    case 'GeolocationTimeout':
      return 'Retry the request, or supply explicit coordinates.'
    case 'InsecureContext':
      return 'Open the application over HTTPS or localhost.'
    case 'RegionUnsupported':
      return `Only ${error.supportedRegions.join(', ')} are currently covered. Pass coordinates inside supported bounds.`
    case 'SourceUnavailable':
      return `Upstream source "${error.sourceId}" is unreachable. Check network or rely on available sources.`
    case 'SourceRateLimited':
      return error.resetAt
        ? `Wait until ${new Date(error.resetAt).toISOString()} for rate limits to reset; cached data may still serve.`
        : 'Wait a moment before retrying request.'
    case 'SourceCircuitOpen':
      return 'Source is failing repeatedly; results will be partial until cooldown expires.'
    case 'UpstreamPayloadInvalid':
      return `Upstream schema changed at "${error.path}". Check provider schema decoding.`
    case 'UpstreamTooLarge':
      return 'Narrow the search radius or zoom level to reduce payload size.'
    case 'HostNotAllowed':
      return 'Add the host to GEO_ALLOWED_HOSTS in environment configuration if intended.'
    case 'TileAnalysisFailed':
      return 'Request fewer tiles or a lower zoom level.'
    case 'RoutingUnavailable':
      return 'Falling back to straight-line distance estimates. Do not use for turn-by-turn navigation.'
    case 'RouteNotFound':
      return 'Try another destination, adjust costing mode, or verify flood exclusion boundaries.'
  }
}
