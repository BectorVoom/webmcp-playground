import type { Effect } from 'effect'
import type { AlertSeverity, OfficialAlert } from '../domain/alerts'
import type { LonLat } from '../domain/geo'
import type { GeoError } from '../domain/geo-errors'
import type { Coverage, Staleness } from '../domain/provenance'
import type { ProviderMeta } from './FloodData'

export interface AlertsQuery {
  readonly at: LonLat
  readonly radiusKm: number
  readonly minSeverity?: AlertSeverity
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface AlertsQueryResult {
  readonly alerts: ReadonlyArray<OfficialAlert>
  readonly totalActiveCount: number
  readonly expiredCount: number
  readonly coverage: Coverage
  readonly staleness: Staleness
}

export interface AlertsPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  readonly alertsFor: (
    query: AlertsQuery,
  ) => Effect.Effect<AlertsQueryResult, GeoError>
}
