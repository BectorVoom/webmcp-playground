/**
 * Pure geographical domain types and coordinate helpers (R1.6, R1.9).
 */

export interface LonLat {
  readonly longitude: number
  readonly latitude: number
}

/** [minLon, minLat, maxLon, maxLat] in WGS84 */
export type BBox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number]

export type Bearing = number // 0 to 360 degrees clockwise from North

export type LocationSource = 'geolocation' | 'explicit' | 'pinned'

export interface ResolvedLocation {
  readonly coordinates: LonLat
  readonly accuracyMetres: number
  readonly source: LocationSource
  readonly resolvedAt: number
}

export interface ClampedRadius {
  readonly radiusKm: number
  readonly requestedKm: number
  readonly wasClamped: boolean
}

export const MIN_RADIUS_KM = 1
export const MAX_RADIUS_KM = 20
export const DEFAULT_RADIUS_KM = 20

export const clampRadius = (requestedKm?: number): ClampedRadius => {
  const req = requestedKm ?? DEFAULT_RADIUS_KM
  if (Number.isNaN(req) || !Number.isFinite(req)) {
    return {
      radiusKm: DEFAULT_RADIUS_KM,
      requestedKm: req,
      wasClamped: true,
    }
  }
  const clamped = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, req))
  return {
    radiusKm: clamped,
    requestedKm: req,
    wasClamped: clamped !== req,
  }
}

/**
 * Coordinate rounding helpers (R1.6, R8.7).
 * 4 decimal places ≈ 11 m (outbound requests)
 * 3 decimal places ≈ 110 m (traces and area queries)
 */
export const roundToDp = (num: number, dp: number): number => {
  const factor = 10 ** dp
  return Math.round(num * factor) / factor
}

export const roundCoords = (coords: LonLat, dp = 4): LonLat => ({
  longitude: roundToDp(coords.longitude, dp),
  latitude: roundToDp(coords.latitude, dp),
})

export const roundCoordsForOutbound = (coords: LonLat): LonLat => roundCoords(coords, 4)
export const roundCoordsForTrace = (coords: LonLat): LonLat => roundCoords(coords, 3)

export type CompassDirection =
  | 'N'
  | 'NNE'
  | 'NE'
  | 'ENE'
  | 'E'
  | 'ESE'
  | 'SE'
  | 'SSE'
  | 'S'
  | 'SSW'
  | 'SW'
  | 'WSW'
  | 'W'
  | 'WNW'
  | 'NW'
  | 'NNW'

export const bearingToDirection = (bearingDeg: number): CompassDirection => {
  const normalised = ((bearingDeg % 360) + 360) % 360
  const directions: ReadonlyArray<CompassDirection> = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ]
  const index = Math.round(normalised / 22.5) % 16
  return directions[index] ?? 'N'
}
