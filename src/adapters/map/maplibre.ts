import { Effect } from 'effect'
import * as maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import type { MapFocusTarget, MapLayerData, MapLayerId, MapPort } from '../../ports/Map'
import { countGeometryVertices } from '../../lib/geometry/simplify'

export interface MapLibreAdapterOptions {
  readonly container?: HTMLElement | string
  readonly basemapUrl?: string
  readonly initialCenter?: [number, number]
  readonly initialZoom?: number
  readonly noBasemap?: boolean
}

export class MapLibreAdapter implements MapPort {
  private map: maplibregl.Map | null = null
  private userMarker: maplibregl.Marker | null = null
  private readonly layers = new Map<MapLayerId, MapLayerData>()
  private currentFocus: MapFocusTarget = 'all'
  private readonly isWebGLAvailable: boolean
  private isLoaded = false

  constructor(options: MapLibreAdapterOptions = {}) {
    const ml = maplibregl as unknown as { readonly supported?: () => boolean }
    this.isWebGLAvailable = typeof ml.supported === 'function' ? ml.supported() : true

    if (options.container && this.isWebGLAvailable) {
      try {
        const defaultStyle: maplibregl.StyleSpecification = options.noBasemap
          ? {
              version: 8,
              sources: {},
              layers: [
                {
                  id: 'background',
                  type: 'background',
                  paint: { 'background-color': '#0f172a' },
                },
              ],
            }
          : {
              version: 8,
              sources: {
                'osm-tiles': {
                  type: 'raster',
                  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                  tileSize: 256,
                  attribution: '© OpenStreetMap contributors',
                },
              },
              layers: [
                {
                  id: 'osm-tiles-layer',
                  type: 'raster',
                  source: 'osm-tiles',
                  minzoom: 0,
                  maxzoom: 19,
                },
              ],
            }

        this.map = new maplibregl.Map({
          container: options.container,
          style: options.basemapUrl || defaultStyle,
          center: options.initialCenter ?? [139.7671, 35.6812],
          zoom: options.initialZoom ?? 12,
        })

        const onReady = () => {
          this.isLoaded = true
          this.syncAllLayersToMap()
        }

        this.map.on('load', onReady)
        this.map.on('style.load', onReady)
      } catch {
        this.map = null
      }
    }
  }

  private isMapReady(): boolean {
    return Boolean(this.map && (this.isLoaded || this.map.isStyleLoaded()))
  }

  private syncAllLayersToMap(): void {
    if (!this.map) return
    for (const [id, data] of this.layers.entries()) {
      this.renderLayerOnMap(id, data.geojson)
      this.applyVisibilityToMap(id, data.visible)
    }

    this.reorderLayers()

    const userLayer = this.layers.get('user-position')
    if (userLayer && userLayer.geojson.features.length > 0) {
      this.updateUserMarker(userLayer.geojson)
    }
  }

  private updateUserMarker(geojson: FeatureCollection): void {
    if (!this.map) return

    const feat = geojson.features[0]
    if (feat && feat.geometry.type === 'Point') {
      const [lng, lat] = feat.geometry.coordinates as [number, number]
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return

      if (!this.userMarker) {
        const el = document.createElement('div')
        el.className = 'webmcp-user-location-marker'
        el.style.width = '24px'
        el.style.height = '24px'
        el.style.position = 'relative'
        el.style.display = 'flex'
        el.style.alignItems = 'center'
        el.style.justifyContent = 'center'

        // Outer pulsing ring
        const ring = document.createElement('div')
        ring.style.position = 'absolute'
        ring.style.width = '100%'
        ring.style.height = '100%'
        ring.style.borderRadius = '50%'
        ring.style.backgroundColor = 'rgba(59, 130, 246, 0.4)'
        ring.style.animation = 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite'

        // Inner solid core dot
        const dot = document.createElement('div')
        dot.style.position = 'relative'
        dot.style.width = '14px'
        dot.style.height = '14px'
        dot.style.borderRadius = '50%'
        dot.style.backgroundColor = '#2563eb'
        dot.style.border = '2.5px solid #ffffff'
        dot.style.boxShadow = '0 0 6px rgba(0,0,0,0.5)'

        el.appendChild(ring)
        el.appendChild(dot)

        this.userMarker = new maplibregl.Marker({ element: el })
          .setLngLat([lng, lat])
          .addTo(this.map)
      } else {
        this.userMarker.setLngLat([lng, lat])
      }
    } else if (this.userMarker) {
      this.userMarker.remove()
      this.userMarker = null
    }
  }

  private reorderLayers(): void {
    if (!this.map || !this.isMapReady()) return
    // Ensure top-level layers stay on top of polygon fills
    const topLayers = [
      'layer-routes-casing',
      'layer-routes',
      'layer-facilities',
      'layer-facilities-label',
      'layer-user-position',
    ]
    for (const lid of topLayers) {
      if (this.map.getLayer(lid)) {
        try {
          this.map.moveLayer(lid)
        } catch {
          // Ignored
        }
      }
    }
  }

  private renderLayerOnMap(id: MapLayerId, geojson: FeatureCollection): void {
    if (!this.map || !this.isMapReady()) return

    if (id === 'user-position') {
      this.updateUserMarker(geojson)
    }

    const sourceId = `src-${id}`
    const existingSource = this.map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined

    if (existingSource) {
      existingSource.setData(geojson)
      this.reorderLayers()
      return
    }

    try {
      this.map.addSource(sourceId, {
        type: 'geojson',
        data: geojson,
      })

      if (id === 'flood-zones') {
        this.map.addLayer({
          id: `layer-${id}-fill`,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': [
              'match',
              ['get', 'hazardClass'],
              'extreme',
              '#7f1d1d',
              'high',
              '#dc2626',
              'moderate',
              '#eab308',
              'low',
              '#22c55e',
              '#64748b',
            ],
            'fill-opacity': 0.55,
          },
        })
        this.map.addLayer({
          id: `layer-${id}-line`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': [
              'match',
              ['get', 'hazardClass'],
              'extreme',
              '#450a0a',
              'high',
              '#991b1b',
              'moderate',
              '#a16207',
              'low',
              '#15803d',
              '#475569',
            ],
            'line-width': 2,
          },
        })
      } else if (id === 'query-radius') {
        this.map.addLayer({
          id: `layer-${id}-fill`,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0.08,
          },
        })
        this.map.addLayer({
          id: `layer-${id}-line`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': '#3b82f6',
            'line-width': 1.5,
            'line-dasharray': [3, 2],
          },
        })
      } else if (id === 'facilities') {
        this.map.addLayer({
          id: `layer-${id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 7,
            'circle-color': [
              'match',
              ['get', 'risk'],
              'clear',
              '#16a34a',
              'at_risk',
              '#dc2626',
              'unknown',
              '#eab308',
              '#16a34a',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        })
        this.map.addLayer({
          id: `layer-${id}-label`,
          type: 'symbol',
          source: sourceId,
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
          },
          paint: {
            'text-color': '#f8fafc',
            'text-halo-color': '#0f172a',
            'text-halo-width': 1.5,
          },
        })
      } else if (id === 'routes') {
        // Casing outline
        this.map.addLayer({
          id: `layer-${id}-casing`,
          type: 'line',
          source: sourceId,
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#ffffff',
            'line-width': 6,
            'line-opacity': 0.6,
          },
        })
        // Primary route line
        this.map.addLayer({
          id: `layer-${id}`,
          type: 'line',
          source: sourceId,
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': [
              'match',
              ['get', 'exclusions'],
              'unavoided',
              '#ea580c',
              'uncovered',
              '#ea580c',
              'unsupported',
              '#9333ea',
              '#2563eb',
            ],
            'line-width': 4,
            'line-opacity': 0.95,
          },
        })
      } else if (id === 'user-position') {
        this.map.addLayer({
          id: `layer-${id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 8,
            'circle-color': '#2563eb',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff',
          },
        })
      } else {
        this.map.addLayer({
          id: `layer-${id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 5,
            'circle-color': '#6366f1',
          },
        })
      }

      this.reorderLayers()
    } catch {
      // Map may be tearing down
    }
  }

  private applyVisibilityToMap(id: MapLayerId, visible: boolean): void {
    if (id === 'user-position' && this.userMarker) {
      this.userMarker.getElement().style.display = visible ? 'flex' : 'none'
    }

    if (!this.map || !this.isMapReady()) return
    const layerIds = [
      `layer-${id}`,
      `layer-${id}-fill`,
      `layer-${id}-line`,
      `layer-${id}-casing`,
      `layer-${id}-label`,
    ]
    for (const lid of layerIds) {
      if (this.map.getLayer(lid)) {
        this.map.setLayoutProperty(lid, 'visibility', visible ? 'visible' : 'none')
      }
    }
  }

  setLayer(
    id: MapLayerId,
    featureCollection: FeatureCollection,
    options: { readonly attributions?: ReadonlyArray<string> } = {},
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const featureCount = featureCollection.features.length
      const vertexCount = featureCollection.features.reduce(
        (sum, feat) => sum + countGeometryVertices(feat.geometry),
        0,
      )

      this.layers.set(id, {
        id,
        visible: true,
        geojson: featureCollection,
        featureCount,
        vertexCount,
        attributions: options.attributions ?? [],
        updatedAt: Date.now(),
      })

      if (this.isMapReady()) {
        this.renderLayerOnMap(id, featureCollection)
        // Automatically fit bounds for new multi-feature flood zones or routes
        if ((id === 'flood-zones' || id === 'routes') && featureCount > 0) {
          this.autoFitFeatures(featureCollection.features)
        }
      }
    })
  }

  private autoFitFeatures(features: ReadonlyArray<Feature>): void {
    if (!this.map) return
    const bounds = new maplibregl.LngLatBounds()

    for (const feat of features) {
      this.extendBoundsWithGeometry(bounds, feat.geometry)
    }

    if (!bounds.isEmpty()) {
      this.map.fitBounds(bounds, { padding: 48, maxZoom: 15 })
    }
  }

  private extendBoundsWithGeometry(bounds: maplibregl.LngLatBounds, geom: GeoJSON.Geometry): void {
    if (geom.type === 'Point') {
      bounds.extend(geom.coordinates as [number, number])
    } else if (geom.type === 'LineString') {
      for (const pt of geom.coordinates) {
        bounds.extend(pt as [number, number])
      }
    } else if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) {
        for (const pt of ring) {
          bounds.extend(pt as [number, number])
        }
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        for (const ring of poly) {
          for (const pt of ring) {
            bounds.extend(pt as [number, number])
          }
        }
      }
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        for (const pt of line) {
          bounds.extend(pt as [number, number])
        }
      }
    }
  }

  toggleLayer(id: MapLayerId, visible: boolean): Effect.Effect<void, never> {
    return Effect.sync(() => {
      const layer = this.layers.get(id)
      if (layer) {
        this.layers.set(id, { ...layer, visible })
        this.applyVisibilityToMap(id, visible)
      }
    })
  }

  focus(target: MapFocusTarget): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.currentFocus = target
      if (this.map) {
        const visibleFeatures: Array<Feature> = []
        for (const layer of this.layers.values()) {
          if (!layer.visible) continue
          if (this.currentFocus === 'all' || layer.id.includes(this.currentFocus)) {
            visibleFeatures.push(...layer.geojson.features)
          }
        }
        if (visibleFeatures.length > 0) {
          const bounds = new maplibregl.LngLatBounds()
          for (const feat of visibleFeatures) {
            this.extendBoundsWithGeometry(bounds, feat.geometry)
          }
          if (!bounds.isEmpty()) {
            this.map.fitBounds(bounds, { padding: 48, maxZoom: 16 })
          }
        }
      }
    })
  }

  clear(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.userMarker) {
        this.userMarker.remove()
        this.userMarker = null
      }

      for (const id of this.layers.keys()) {
        const sourceId = `src-${id}`
        const layerIds = [
          `layer-${id}`,
          `layer-${id}-fill`,
          `layer-${id}-line`,
          `layer-${id}-casing`,
          `layer-${id}-label`,
        ]
        if (this.map && this.isMapReady()) {
          for (const lid of layerIds) {
            if (this.map.getLayer(lid)) {
              this.map.removeLayer(lid)
            }
          }
          if (this.map.getSource(sourceId)) {
            this.map.removeSource(sourceId)
          }
        }
      }
      this.layers.clear()
    })
  }

  readLayer(id: MapLayerId): Effect.Effect<MapLayerData | undefined, never> {
    return Effect.sync(() => this.layers.get(id))
  }

  readAllLayers(): Effect.Effect<ReadonlyArray<MapLayerData>, never> {
    return Effect.sync(() => Array.from(this.layers.values()))
  }

  destroy(): void {
    if (this.userMarker) {
      this.userMarker.remove()
      this.userMarker = null
    }

    if (this.map) {
      try {
        this.map.remove()
      } catch {
        // Ignored
      }
      this.map = null
    }
  }
}
