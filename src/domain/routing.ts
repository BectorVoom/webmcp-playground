import type { LineString } from 'geojson'
import type { SafeFacility } from './places'
import type { Provenance } from './provenance'

export type RouteCosting = 'pedestrian' | 'bicycle' | 'auto'

export type ExclusionState = 'applied' | 'unavoided' | 'not_requested'

export interface RouteStep {
  readonly instruction: string
  readonly metres: number
  readonly seconds: number
  readonly streetNames?: ReadonlyArray<string>
}

export interface CrossingReport {
  readonly count: number
  readonly firstAtMetres: number | null
  readonly assessed: boolean // false when there was no flood coverage to assess against
}

export interface RoutingEngineInfo {
  readonly name: 'valhalla'
  readonly costingNotes: string
  readonly dataVintage?: string
}

export interface EvacuationRoute {
  readonly destination: SafeFacility
  readonly costing: RouteCosting
  readonly metres: number
  readonly seconds: number
  readonly geometry: LineString
  readonly steps: ReadonlyArray<RouteStep>
  readonly exclusions: ExclusionState
  readonly crossings: CrossingReport
  readonly engine: RoutingEngineInfo
  readonly provenance: Provenance
}
