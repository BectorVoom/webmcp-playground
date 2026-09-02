import type { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'

export type MapLayerId =
  | 'user-position'
  | 'query-radius'
  /** Inundation an authority has mapped or is forecasting — GSI, FEMA, GloFAS, キキクル. */
  | 'flood-zones'
  /**
   * Inundation *this system modelled*, from `/api/geo/flood-model`.
   *
   * Deliberately a layer of its own rather than more features on `flood-zones`. A screening model
   * driven by a design storm is not a hazard map an authority stands behind, and the two must not
   * be indistinguishable once they are on the same canvas — which they would be, since the
   * properties written to a feature carry no source. ADR-2 keeps a forecast out of a scenario for
   * exactly this reason; this is the same rule applied to a modelled estimate.
   */
  | 'inundation-model'
  | 'facilities'
  | 'routes'
  /** Places resolved from a name by the geocoder — where the user asked about, not where they are. */
  | 'search-results'

export interface MapLayerData {
  readonly id: MapLayerId
  readonly visible: boolean
  readonly geojson: FeatureCollection
  readonly featureCount: number
  readonly vertexCount: number
  readonly attributions: ReadonlyArray<string>
  readonly updatedAt: number
}

export type MapFocusTarget =
  | 'user'
  | 'floods'
  | 'modelled-inundation'
  | 'facilities'
  | 'routes'
  | 'search'
  | 'all'

/**
 * Which layers a focus target frames. Explicit rather than inferred from the target's name: the
 * substring match this replaced silently framed nothing at all for 'floods', because the layer is
 * called 'flood-zones' and `'flood-zones'.includes('floods')` is false.
 */
export const LAYERS_FOR_FOCUS: Record<Exclude<MapFocusTarget, 'all'>, ReadonlyArray<MapLayerId>> = {
  user: ['user-position'],
  floods: ['flood-zones'],
  'modelled-inundation': ['inundation-model'],
  facilities: ['facilities'],
  routes: ['routes'],
  search: ['search-results'],
}

export interface MapPort {
  readonly setLayer: (
    id: MapLayerId,
    featureCollection: FeatureCollection,
    options?: { readonly attributions?: ReadonlyArray<string> },
  ) => Effect.Effect<void, never>
  readonly toggleLayer: (id: MapLayerId, visible: boolean) => Effect.Effect<void, never>
  readonly focus: (target: MapFocusTarget) => Effect.Effect<void, never>
  readonly clear: () => Effect.Effect<void, never>
  readonly readLayer: (id: MapLayerId) => Effect.Effect<MapLayerData | undefined, never>
  readonly readAllLayers: () => Effect.Effect<ReadonlyArray<MapLayerData>, never>
}
