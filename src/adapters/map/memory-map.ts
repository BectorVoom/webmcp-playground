import { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'
import type { MapFocusTarget, MapLayerData, MapLayerId, MapPort } from '../../ports/Map'
import { countGeometryVertices } from '../../lib/geometry/simplify'

export class MemoryMapAdapter implements MapPort {
  private readonly layers = new Map<MapLayerId, MapLayerData>()
  private currentFocus: MapFocusTarget = 'all'

  setLayer(
    id: MapLayerId,
    geojson: FeatureCollection,
    options: { readonly attributions?: ReadonlyArray<string> } = {},
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const featureCount = geojson.features.length
      const vertexCount = geojson.features.reduce(
        (sum, feat) => sum + countGeometryVertices(feat.geometry),
        0,
      )

      this.layers.set(id, {
        id,
        visible: true,
        geojson,
        featureCount,
        vertexCount,
        attributions: options.attributions ?? [],
        updatedAt: Date.now(),
      })
    })
  }

  toggleLayer(id: MapLayerId, visible: boolean): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const layer = this.layers.get(id)
      if (layer) {
        this.layers.set(id, { ...layer, visible })
      }
    })
  }

  focus(target: MapFocusTarget): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.currentFocus = target
    })
  }

  clear(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.layers.clear()
    })
  }

  readLayer(id: MapLayerId): Effect.Effect<MapLayerData | undefined, never> {
    return Effect.sync(() => this.layers.get(id))
  }

  readAllLayers(): Effect.Effect<ReadonlyArray<MapLayerData>, never> {
    return Effect.sync(() => Array.from(this.layers.values()))
  }

  getFocus(): MapFocusTarget {
    return this.currentFocus
  }
}

export const defaultMapPort = new MemoryMapAdapter()
