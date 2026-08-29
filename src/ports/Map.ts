import type { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'

export type MapLayerId =
  | 'user-position'
  | 'query-radius'
  | 'flood-zones'
  | 'facilities'
  | 'routes'

export interface MapLayerData {
  readonly id: MapLayerId
  readonly visible: boolean
  readonly geojson: FeatureCollection
  readonly featureCount: number
  readonly vertexCount: number
  readonly attributions: ReadonlyArray<string>
  readonly updatedAt: number
}

export type MapFocusTarget = 'user' | 'floods' | 'facilities' | 'routes' | 'all'

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
