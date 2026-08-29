import type { Effect } from 'effect'
import type { LonLat } from '../domain/geo'
import type { GeoError } from '../domain/geo-errors'
import type { FacilityCategory, SafeFacility } from '../domain/places'
import type { Coverage, Staleness } from '../domain/provenance'
import type { ProviderMeta } from './FloodData'

export interface PlacesQuery {
  readonly at: LonLat
  readonly radiusKm: number
  readonly limit?: number
  readonly category?: FacilityCategory
  readonly signal?: AbortSignal
}

export interface PlacesQueryResult {
  readonly facilities: ReadonlyArray<SafeFacility>
  readonly coverage: Coverage
  readonly staleness: Staleness
}

export interface PlacesPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  readonly facilitiesWithin: (
    query: PlacesQuery,
  ) => Effect.Effect<PlacesQueryResult, GeoError>
}
