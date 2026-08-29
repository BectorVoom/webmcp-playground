import type { Effect } from 'effect'
import type { LonLat } from '../domain/geo'
import type { GeoError } from '../domain/geo-errors'
import type { FloodZone } from '../domain/hazard'
import type { Coverage, Staleness } from '../domain/provenance'

export interface ProviderMeta {
  readonly sourceId: string
  readonly sourceName: string
  readonly docsUrl: string
  readonly vintage?: string
  readonly licence: string
  readonly attribution: string
  readonly expectedRefreshMs?: number
}

export interface FloodQuery {
  readonly at: LonLat
  readonly radiusKm: number
  readonly horizonHours?: number
  readonly signal?: AbortSignal
}

export interface FloodQueryResult {
  readonly zones: ReadonlyArray<FloodZone>
  readonly coverage: Coverage
  readonly staleness: Staleness
}

export interface FloodDataPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  readonly zonesWithin: (
    query: FloodQuery,
  ) => Effect.Effect<FloodQueryResult, GeoError>
}
