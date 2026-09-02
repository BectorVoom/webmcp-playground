import { Effect } from 'effect'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Feature, FeatureCollection, Point } from 'geojson'
import {
  FLOOD_FILL_OPACITY,
  hatchImages,
  hazardHatchExpression,
  hazardMatchExpression,
} from '../../lib/hazard-palette'
import {
  LAYERS_FOR_FOCUS,
  type MapFocusTarget,
  type MapLayerData,
  type MapLayerId,
  type MapPort,
} from '../../ports/Map'
import { countGeometryVertices } from '../../lib/geometry/simplify'

/**
 * MapLibre derives its worker URL from its own `import.meta.url` at runtime, which no bundler can
 * follow: Vite rewrites that to the pre-bundle (dev) or to the app chunk (build), and the sibling
 * `maplibre-gl-worker.mjs` it then asks for does not exist. The worker 404s, every GeoJSON source
 * stays unloaded, and flood zones, shelters and routes silently render nothing while the raster
 * basemap still draws. `?worker&url` makes Vite emit the worker — together with the
 * `maplibre-gl-shared.mjs` chunk it imports — and hands us the URL that actually resolves.
 */
maplibregl.setWorkerUrl(maplibreWorkerUrl)

export interface MapLibreAdapterOptions {
  readonly container?: HTMLElement | string
  readonly basemapUrl?: string
  readonly initialCenter?: [number, number]
  readonly initialZoom?: number
  readonly noBasemap?: boolean
}

/** Risk-coded fill shared by the shelter halo and its solid core, so the two never drift apart. */
const RISK_COLOUR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'risk'],
  'clear',
  '#16a34a',
  'at_risk',
  '#dc2626',
  'unknown',
  '#eab308',
  '#16a34a',
]

/**
 * Draw order of the logical layers, bottom to top. Shelter points and routes must sit above the
 * flood polygons that otherwise bury them.
 */
const LAYER_STACK_ORDER: ReadonlyArray<MapLayerId> = [
  'query-radius',
  // Below `flood-zones`, so an authority's mapped hazard draws over this system's estimate of it
  // wherever both exist. Where they disagree, the published map is the one that should be read.
  'inundation-model',
  'flood-zones',
  'routes',
  'facilities',
  'search-results',
  'user-position',
]

const sourceIdFor = (id: MapLayerId): string => `src-${id}`

/**
 * Layers whose arrival moves the camera to frame them.
 *
 * Named once because it was written out twice — on load and on every `setLayer` — and a layer
 * added to one copy and not the other simply never gets framed, with nothing to show why. That is
 * the same drift the id lists above already suffered.
 */
const AUTO_FIT_LAYERS: ReadonlyArray<MapLayerId> = [
  'flood-zones',
  'inundation-model',
  'routes',
  'facilities',
  'search-results',
]

/**
 * One logical layer's rendering state, from the data given to it down to the features that
 * actually reached the canvas. See `MapLibreAdapter.inspectRendering`.
 */
export interface RenderedLayerReport {
  readonly id: MapLayerId
  readonly sourceId: string
  readonly sourcePresent: boolean
  /** Features handed to the source. */
  readonly featureCount: number
  readonly visible: boolean
  readonly renderLayers: ReadonlyArray<{
    readonly id: string
    readonly present: boolean
    /** 'visible' | 'none' while present, otherwise 'absent'. */
    readonly visibility: string
  }>
  /** Features MapLibre rasterised in the current viewport. */
  readonly renderedFeatureCount: number
}

/**
 * Every MapLibre layer a logical layer renders as, in bottom-to-top draw order.
 *
 * This is the single source of truth for rendering, reordering, visibility and teardown. Three
 * hand-maintained id lists drifted apart once already: the facilities halo was missing from
 * teardown, so `clear()` left the source in use, aborted mid-way, and shelter points never
 * rendered again for the rest of the session.
 */
const layerSpecsFor = (
  id: MapLayerId,
  sourceId: string,
  activeRouteRank = 1,
): ReadonlyArray<maplibregl.LayerSpecification> => {
  /** True for the one route the reader is currently following. */
  const isActive: maplibregl.ExpressionSpecification = [
    '==',
    ['get', 'rank'],
    activeRouteRank,
  ]

  switch (id) {
    case 'flood-zones':
    case 'inundation-model':
      // Colours come from `HAZARD_PALETTE`, which the legend reads too. Writing them out here as
      // well is what let the map and the legend disagree about every band at once.
      return [
        {
          id: `layer-${id}-fill`,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': hazardMatchExpression('fill') as maplibregl.ExpressionSpecification,
            'fill-opacity': FLOOD_FILL_OPACITY,
          },
        },
        {
          // The texture that makes depth survive desaturation and colour-vision deficiency (R5.7).
          // A second layer rather than a `fill-pattern` on the one above, because a pattern
          // overrides `fill-color` — one patterned layer would encode class in texture *instead*
          // of colour, trading one single-channel encoding for another.
          id: `layer-${id}-hatch`,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-pattern': hazardHatchExpression() as unknown as maplibregl.ExpressionSpecification,
          },
        },
        {
          id: `layer-${id}-line`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': hazardMatchExpression('line') as maplibregl.ExpressionSpecification,
            'line-width': 2,
            // A dashed edge marks the modelled estimate. Nothing else on the map distinguishes it
            // from an authority's mapped hazard, and the two must not read alike.
            ...(id === 'inundation-model' ? { 'line-dasharray': [2, 2] as [number, number] } : {}),
          },
        },
      ]

    case 'query-radius':
      return [
        {
          id: `layer-${id}-fill`,
          type: 'fill',
          source: sourceId,
          paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 },
        },
        {
          id: `layer-${id}-line`,
          type: 'line',
          source: sourceId,
          paint: { 'line-color': '#3b82f6', 'line-width': 1.5, 'line-dasharray': [3, 2] },
        },
      ]

    case 'facilities':
      return [
        // Soft outer halo for visibility against a dense basemap or flood fills.
        {
          id: `layer-${id}-halo`,
          type: 'circle',
          source: sourceId,
          paint: { 'circle-radius': 14, 'circle-color': RISK_COLOUR, 'circle-opacity': 0.3 },
        },
        // Solid core point marker.
        {
          id: `layer-${id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 8,
            'circle-color': RISK_COLOUR,
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#ffffff',
          },
        },
        // Shelter name, with collision bypass so no label is silently dropped.
        {
          id: `layer-${id}-label`,
          type: 'symbol',
          source: sourceId,
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.3],
            'text-anchor': 'top',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#f8fafc',
            'text-halo-color': '#0f172a',
            'text-halo-width': 2,
          },
        },
      ]

    case 'routes':
      return [
        // Only the active route gets a casing. Haloing every alternative is what turns a set of
        // options into a thicket you cannot read the recommendation out of.
        {
          id: `layer-${id}-casing`,
          type: 'line',
          source: sourceId,
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
            'line-sort-key': ['case', isActive, 1, 0],
          },
          paint: {
            'line-color': '#ffffff',
            'line-width': 8,
            'line-opacity': ['case', isActive, 0.65, 0],
          },
        },
        {
          id: `layer-${id}`,
          type: 'line',
          source: sourceId,
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
            // Draw the active route last so it sits over the alternatives it crosses.
            'line-sort-key': ['case', isActive, 1, 0],
          },
          paint: {
            'line-color': [
              'case',
              isActive,
              [
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
              // Alternatives stay legible but plainly secondary, the way a navigation app greys
              // the routes you did not pick.
              '#94a3b8',
            ],
            'line-width': ['case', isActive, 5, 3],
            'line-opacity': ['case', isActive, 0.95, 0.45],
          },
        },
      ]

    case 'search-results':
      return [
        // Magenta, which appears nowhere else on this map. Amber was the obvious pick and the
        // wrong one: it is a hair from the yellow that means "shelter of unknown flood risk", and
        // a place the user merely asked about must never read as somewhere they can shelter.
        {
          id: `layer-${id}-halo`,
          type: 'circle',
          source: sourceId,
          paint: { 'circle-radius': 13, 'circle-color': '#db2777', 'circle-opacity': 0.25 },
        },
        {
          id: `layer-${id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 7,
            'circle-color': '#db2777',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#ffffff',
          },
        },
        {
          id: `layer-${id}-label`,
          type: 'symbol',
          source: sourceId,
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.3],
            'text-anchor': 'top',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#fce7f3',
            'text-halo-color': '#0f172a',
            'text-halo-width': 2,
          },
        },
      ]

    case 'user-position':
      return [
        {
          id: `layer-${id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-radius': 8,
            'circle-color': '#2563eb',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff',
          },
        },
      ]
  }
}

const layerIdsFor = (id: MapLayerId): ReadonlyArray<string> =>
  layerSpecsFor(id, sourceIdFor(id)).map((spec) => spec.id)

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export class MapLibreAdapter implements MapPort {
  private map: maplibregl.Map | null = null
  private userMarker: maplibregl.Marker | null = null
  private readonly layers = new Map<MapLayerId, MapLayerData>()
  /** Delegated click/hover handlers are bound once per layer id; they survive layer rebuilds. */
  private readonly interactionsBound = new Set<MapLayerId>()
  private currentFocus: MapFocusTarget = 'all'
  /** Rank 1 is the safest route the planner found, so it is what the map opens on. */
  private activeRouteRank = 1
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
              glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
          // JP shelter names are CJK and the remote glyph server carries no CJK ranges; without
          // this every Japanese shelter label would silently fail to draw.
          localIdeographFontFamily: "'Hiragino Sans', 'Noto Sans CJK JP', 'Yu Gothic', sans-serif",
        })

        const onReady = () => {
          this.isLoaded = true
          this.registerHatchImages()
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

  /**
   * Registers the depth hatches, once the style exists to hold them.
   *
   * A `fill-pattern` naming an image the map does not have draws **nothing** — not the fill
   * underneath, nothing — and MapLibre reports it as a warning rather than an error. So these have
   * to be in place before any patterned layer is added, which is why this runs on load rather than
   * lazily beside the layer that uses them.
   */
  private registerHatchImages(): void {
    if (!this.map) return
    for (const { id, image } of hatchImages()) {
      try {
        if (!this.map.hasImage(id)) this.map.addImage(id, image)
      } catch {
        // An image that will not register costs the texture, not the layer: the colour fill and
        // the outline are separate layers and still draw.
      }
    }
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

    // Auto-fit features if any multi-feature layers exist upon map load
    for (const [id, data] of this.layers.entries()) {
      if (AUTO_FIT_LAYERS.includes(id) && data.featureCount > 0) {
        this.autoFitFeatures(data.geojson.features)
        break
      }
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

  /** Restores the documented stack order; MapLibre otherwise draws in insertion order. */
  private reorderLayers(): void {
    if (!this.map || !this.isMapReady()) return
    for (const logicalId of LAYER_STACK_ORDER) {
      for (const lid of layerIdsFor(logicalId)) {
        if (this.map.getLayer(lid)) {
          try {
            this.map.moveLayer(lid)
          } catch {
            // Layer vanished between the check and the move; the next sync re-establishes order.
          }
        }
      }
    }
  }

  private renderLayerOnMap(id: MapLayerId, geojson: FeatureCollection): void {
    if (!this.map || !this.isMapReady()) return

    if (id === 'user-position') {
      this.updateUserMarker(geojson)
    }

    const sourceId = sourceIdFor(id)
    const specs = layerSpecsFor(id, sourceId, this.activeRouteRank)

    try {
      const existingSource = this.map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined
      if (existingSource) {
        existingSource.setData(geojson)
      } else {
        this.map.addSource(sourceId, { type: 'geojson', data: geojson })
      }

      // Add only what is actually missing. A surviving source says nothing about its render
      // layers: a partially failed teardown can leave the source with some or none of them.
      for (const spec of specs) {
        if (!this.map.getLayer(spec.id)) {
          this.map.addLayer(spec)
        }
      }

      this.bindInteractions(id)
      this.reorderLayers()
    } catch {
      // Map may be tearing down
    }
  }

  /** Popups and cursor affordances for the layers that carry per-feature detail. */
  private bindInteractions(id: MapLayerId): void {
    if (!this.map || this.interactionsBound.has(id)) return
    if (id !== 'facilities' && id !== 'routes') return

    const map = this.map
    const layerId = `layer-${id}`

    map.on('click', layerId, (e) => {
      const feat = e.features?.[0]
      if (!feat) return
      const props = feat.properties ?? {}
      const popup = new maplibregl.Popup({ offset: id === 'facilities' ? 12 : 10 })

      if (id === 'facilities') {
        const riskColor =
          props.risk === 'clear' ? '#16a34a' : props.risk === 'at_risk' ? '#dc2626' : '#eab308'
        const riskLabel =
          props.risk === 'clear' ? 'Safe (Clear)' : props.risk === 'at_risk' ? 'At Risk' : 'Unknown Risk'
        const distStr = props.distanceMetres ? `${escapeHtml(props.distanceMetres)} m` : ''
        const category = props.category ? escapeHtml(String(props.category).replace('_', ' ')) : 'Shelter'

        popup.setLngLat((feat.geometry as Point).coordinates as [number, number]).setHTML(`
          <div style="font-family: sans-serif; font-size: 12px; color: #0f172a; padding: 4px;">
            <div style="font-weight: bold; font-size: 13px; margin-bottom: 2px;">${escapeHtml(props.name) || 'Safe Shelter'}</div>
            <div style="font-size: 11px; color: #64748b; margin-bottom: 4px;">${category} ${distStr ? `• ${distStr}` : ''}</div>
            <div style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-weight: 600; font-size: 10px; color: #fff; background-color: ${riskColor};">
              ${riskLabel}
            </div>
          </div>
        `)
      } else {
        const rank = props.rank ? `Route #${escapeHtml(props.rank)}` : 'Evacuation Route'
        const dest = escapeHtml(props.destination) || 'Destination'
        const metres = props.metres ? `${escapeHtml(props.metres)} m` : ''
        const mins = props.seconds ? `~${Math.round(Number(props.seconds) / 60)} mins` : ''
        const exclusions =
          props.exclusions === 'unavoided' ? '⚠️ May Cross Flood Zone' : '✅ Flood Exclusions Applied'
        const crossings =
          props.crossings && Number(props.crossings) > 0
            ? `(${escapeHtml(props.crossings)} flood crossings)`
            : '(No flood crossings)'

        popup.setLngLat(e.lngLat).setHTML(`
          <div style="font-family: sans-serif; font-size: 12px; color: #0f172a; padding: 4px;">
            <div style="font-weight: bold; font-size: 13px; margin-bottom: 2px;">${rank}: to ${dest}</div>
            <div style="font-size: 11px; color: #64748b; margin-bottom: 4px;">${metres} ${mins ? `(${mins})` : ''}</div>
            <div style="font-size: 11px; font-weight: 600; color: ${props.exclusions === 'unavoided' ? '#ea580c' : '#2563eb'}; margin-bottom: 2px;">
              ${exclusions}
            </div>
            <div style="font-size: 10px; color: #64748b;">${crossings}</div>
          </div>
        `)
      }

      popup.addTo(map)
    })

    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = ''
    })

    this.interactionsBound.add(id)
  }

  private applyVisibilityToMap(id: MapLayerId, visible: boolean): void {
    if (id === 'user-position' && this.userMarker) {
      this.userMarker.getElement().style.display = visible ? 'flex' : 'none'
    }

    if (!this.map || !this.isMapReady()) return
    for (const lid of layerIdsFor(id)) {
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
        // Automatically fit bounds for new multi-feature flood zones, routes, or facilities
        if (AUTO_FIT_LAYERS.includes(id) && featureCount > 0) {
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

  /**
   * Highlights one route and greys the rest, the way a navigation app shows the one you are on.
   *
   * Selection is paint, not data: re-styling leaves the geometry the tool published untouched, so
   * the directions panel and the map cannot drift apart over which route is which.
   */
  highlightRoute(rank: number): void {
    this.activeRouteRank = rank
    if (!this.map || !this.isMapReady()) return
    for (const spec of layerSpecsFor('routes', sourceIdFor('routes'), rank)) {
      if (!this.map.getLayer(spec.id)) continue
      try {
        // The spec is our own literal; MapLibre's setters key on a narrower union than
        // Object.entries can express, and re-declaring every property name here would be a
        // second list to keep in step with layerSpecsFor.
        const setPaint = this.map.setPaintProperty.bind(this.map) as (
          layer: string,
          name: string,
          value: unknown,
        ) => void
        const setLayout = this.map.setLayoutProperty.bind(this.map) as (
          layer: string,
          name: string,
          value: unknown,
        ) => void
        for (const [property, value] of Object.entries(spec.paint ?? {})) {
          setPaint(spec.id, property, value)
        }
        for (const [property, value] of Object.entries(spec.layout ?? {})) {
          setLayout(spec.id, property, value)
        }
      } catch {
        // Layer went away mid-update; the next render re-applies the style.
      }
    }
  }

  /** The route currently drawn as active, for tests and for the UI to stay in step with. */
  getActiveRouteRank(): number {
    return this.activeRouteRank
  }

  /**
   * What MapLibre is actually drawing, layer by layer.
   *
   * A map with nothing on it raises four separate questions — is the data missing, the source
   * gone, the layer absent, or is it hidden? — and answers none of them. This answers all four,
   * and `renderedFeatureCount` comes from `queryRenderedFeatures`, so it counts what reached the
   * canvas rather than what was handed to the source. The two diverge exactly when something is
   * wrong, which is the moment the distinction is worth having.
   */
  inspectRendering(): ReadonlyArray<RenderedLayerReport> {
    return LAYER_STACK_ORDER.filter((id) => this.layers.has(id)).map((id) => {
      const data = this.layers.get(id)!
      const sourceId = sourceIdFor(id)
      const ready = Boolean(this.map) && this.isMapReady()

      const renderLayers = layerIdsFor(id).map((lid) => {
        const present = ready && Boolean(this.map!.getLayer(lid))
        let visibility = 'absent'
        if (present) {
          try {
            // MapLibre reports undefined for a layout property never set; the spec default for
            // `visibility` is 'visible', and a reader needs the effective value, not the literal.
            visibility = (this.map!.getLayoutProperty(lid, 'visibility') as string) ?? 'visible'
          } catch {
            visibility = 'unknown'
          }
        }
        return { id: lid, present, visibility }
      })

      let renderedFeatureCount = 0
      const drawn = renderLayers.filter((l) => l.present).map((l) => l.id)
      if (ready && drawn.length > 0) {
        try {
          renderedFeatureCount = this.map!.queryRenderedFeatures({ layers: drawn }).length
        } catch {
          // Querying before the first render pass throws; nothing is drawn yet, which is 0.
        }
      }

      return {
        id,
        sourceId,
        sourcePresent: ready && Boolean(this.map!.getSource(sourceId)),
        featureCount: data.featureCount,
        visible: data.visible,
        renderLayers,
        renderedFeatureCount,
      }
    })
  }

  /**
   * Brings a single point into view — used when a reader picks a step out of the directions list.
   * Deliberately not on `MapPort`: it is a camera nicety for the UI, not something a tool needs.
   */
  flyTo(at: { readonly longitude: number; readonly latitude: number }, zoom = 16): void {
    if (!this.map) return
    if (!Number.isFinite(at.longitude) || !Number.isFinite(at.latitude)) return
    try {
      this.map.flyTo({ center: [at.longitude, at.latitude], zoom, essential: true })
    } catch {
      // Map may be tearing down.
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
          if (
            this.currentFocus === 'all' ||
            LAYERS_FOR_FOCUS[this.currentFocus].includes(layer.id)
          ) {
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
        if (!this.map || !this.isMapReady()) continue

        // Every render layer must go before the source: MapLibre refuses to remove a source that
        // any layer still references, and a throw here would strand the rest of the teardown.
        for (const lid of layerIdsFor(id)) {
          try {
            if (this.map.getLayer(lid)) {
              this.map.removeLayer(lid)
            }
          } catch {
            // Already gone; nothing to undo.
          }
        }

        try {
          if (this.map.getSource(sourceIdFor(id))) {
            this.map.removeSource(sourceIdFor(id))
          }
        } catch {
          // Left in place — renderLayerOnMap reuses a surviving source rather than failing.
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
