import type { Effect } from 'effect'
import type { ResolvedLocation } from '../domain/geo'
import type { GeoError } from '../domain/geo-errors'

export interface GeolocationOptions {
  readonly maximumAgeMs?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface GeolocationPort {
  readonly getCurrentPosition: (
    options?: GeolocationOptions,
  ) => Effect.Effect<ResolvedLocation, GeoError>
  readonly setPinnedPosition: (location: ResolvedLocation | null) => void
  readonly getPinnedPosition: () => ResolvedLocation | null
}
