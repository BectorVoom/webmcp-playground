import type { Effect } from 'effect'
import type { MultiPolygon, Polygon } from 'geojson'
import type { LonLat } from '../domain/geo'
import type { GeoError } from '../domain/geo-errors'
import type { SafeFacility } from '../domain/places'
import type { EvacuationRoute, RouteCosting } from '../domain/routing'
import type { ProviderMeta } from './FloodData'

export interface RouteQuery {
  readonly origin: LonLat
  readonly destinations: ReadonlyArray<SafeFacility>
  readonly costing: RouteCosting
  readonly exclusions?: ReadonlyArray<Polygon | MultiPolygon>
  readonly signal?: AbortSignal
}

export type DestinationRouteResult =
  | { readonly ok: true; readonly route: EvacuationRoute }
  | { readonly ok: false; readonly destinationId: string; readonly error: GeoError }

export interface RoutingQueryResult {
  readonly results: ReadonlyArray<DestinationRouteResult>
  readonly costing: RouteCosting
  readonly engineNotes: string
}

export interface RoutingPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  readonly route: (
    query: RouteQuery,
  ) => Effect.Effect<RoutingQueryResult, GeoError>
}
