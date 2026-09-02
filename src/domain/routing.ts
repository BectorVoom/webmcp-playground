import type { LineString } from 'geojson'
import type { LonLat } from './geo'
import type { SafeFacility } from './places'
import type { Provenance } from './provenance'

export type RouteCosting = 'pedestrian' | 'bicycle' | 'auto'

export type ExclusionState = 'applied' | 'unavoided' | 'not_requested'

/**
 * Whether a route's geometry was traced along a road network or drawn between two points.
 *
 * A straight line to a shelter is a bearing and a distance, not a way to get there: it runs
 * through buildings, over rivers and across railways. Presenting one in the same style as a
 * routed path invites a reader to walk it during an evacuation, so the distinction is carried on
 * the route itself, and only `road` is ever drawn as a route line (R3.1).
 */
export type RouteNetwork = 'road' | 'straight-line'

/**
 * The manoeuvre a step asks for, in the vocabulary every turn-by-turn engine shares. Kept separate
 * from `instruction` so the UI can show an arrow without parsing prose, and so a Japanese or German
 * instruction still gets the right icon.
 */
export type RouteManeuver =
  | 'depart'
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'arrive'

export interface RouteStep {
  readonly instruction: string
  readonly metres: number
  readonly seconds: number
  readonly streetNames?: ReadonlyArray<string>
  /** Absent when the engine did not classify the turn; renderers fall back to going straight on. */
  readonly maneuver?: RouteManeuver
  /** Where the step begins, so a reader can put it on the map. */
  readonly at?: LonLat
}

export interface CrossingReport {
  readonly count: number
  readonly firstAtMetres: number | null
  readonly assessed: boolean // false when there was no flood coverage to assess against
  /**
   * How much of the path runs through flood water. A count of crossings says how often the route
   * meets a zone boundary; only this says whether that means stepping over a corner of one or
   * wading four hundred metres, which is the difference that decides which candidate is safest.
   */
  readonly exposedMetres: number
}

export interface RoutingEngineInfo {
  /** The engine itself. Stadia Maps runs Valhalla, so the wire format is Valhalla's either way. */
  readonly name: 'valhalla'
  /**
   * Who ran it. Kept separate from `name` because they answer different questions: what the
   * costing model is, and who to ask when a route looks wrong or the quota runs out.
   */
  readonly hostedBy?: 'stadia-maps' | 'openstreetmap-de' | 'self-hosted' | 'recorded'
  readonly costingNotes: string
  readonly dataVintage?: string
}

export interface EvacuationRoute {
  readonly destination: SafeFacility
  readonly costing: RouteCosting
  /** Set by whichever provider produced the geometry; the planner draws `road` routes only. */
  readonly network: RouteNetwork
  readonly metres: number
  readonly seconds: number
  readonly geometry: LineString
  readonly steps: ReadonlyArray<RouteStep>
  readonly exclusions: ExclusionState
  readonly crossings: CrossingReport
  readonly engine: RoutingEngineInfo
  readonly provenance: Provenance
}
