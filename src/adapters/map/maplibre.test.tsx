import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'
import { HAZARD_PALETTE, hazardMatchExpression } from '../../lib/hazard-palette'
import {
  createdMaps,
  popupsAdded,
  workerUrls,
  type FakeMap,
} from './testing/maplibre-mock'

// The fake lives in ./testing/maplibre-mock so the inundation-rendering suite drives the same
// one; a second copy would drift from this file's expectations without either failing.
vi.mock('maplibre-gl', async () => (await import('./testing/maplibre-mock')).maplibreModuleMock())

const { MapLibreAdapter } = await import('./maplibre')

const routes: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[139.7671, 35.6812], [139.762, 35.6755], [139.756, 35.674]] },
      properties: { rank: 1, destination: '芝公園 Disaster Base', metres: 2900, seconds: 2300, exclusions: 'applied', crossings: 0 },
    },
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[139.7671, 35.6812], [139.774, 35.714]] },
      properties: { rank: 2, destination: 'Ueno Onshi Park', metres: 3700, seconds: 3083, exclusions: 'unavoided', crossings: 2 },
    },
  ],
}

const shelters: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.77, 35.686] },
      properties: { id: 'jp-1', name: '指定緊急避難場所 (北部地区センター)', risk: 'clear', distanceMetres: 740 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.781, 35.683] },
      properties: { id: 'jp-2', name: '指定避難所 (東部コミュニティスクール)', risk: 'at_risk', distanceMetres: 1290 },
    },
  ],
}

const floodZones: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[139.76, 35.68], [139.79, 35.68], [139.79, 35.7], [139.76, 35.7], [139.76, 35.68]]],
      },
      properties: { id: 'z1', hazardClass: 'high' },
    },
  ],
}

const SHELTER_LAYERS = ['layer-facilities-halo', 'layer-facilities', 'layer-facilities-label']
const ROUTE_LAYERS = ['layer-routes-casing', 'layer-routes']

/** Reads a style property off a rendered layer, failing loudly if the layer is absent. */
const styleProp = (map: FakeMap, layerId: string, bucket: 'paint' | 'layout', key: string): unknown => {
  const layer = map.getLayer(layerId)
  if (!layer) throw new Error(`layer '${layerId}' is not on the map`)
  return (layer[bucket] as Record<string, unknown> | undefined)?.[key]
}

/** A loaded adapter plus the fake map behind it. */
const mountLoadedAdapter = () => {
  const adapter = new MapLibreAdapter({ container: document.createElement('div') })
  const map = createdMaps[createdMaps.length - 1]!
  map.styleLoaded = true
  map.fire('load')
  return { adapter, map }
}

describe('MapLibreAdapter shelter rendering (R5.2, R5.7)', () => {
  beforeEach(() => {
    createdMaps.length = 0
    popupsAdded.length = 0
  })

  it('renders shelters as point, halo and label layers bound to their source', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))

    for (const lid of SHELTER_LAYERS) {
      expect(map.getLayer(lid), `${lid} must exist`).toBeTruthy()
    }
    expect(map.droppedLayers).toEqual([])
    expect(map.getLayer('layer-facilities')).toMatchObject({ type: 'circle', source: 'src-facilities' })
    expect(map.getSource('src-facilities')?.data).toBe(shelters)
  })

  it('renders shelters queued before the style finished loading', async () => {
    const adapter = new MapLibreAdapter({ container: document.createElement('div') })
    const map = createdMaps[createdMaps.length - 1]!

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    expect(map.getLayer('layer-facilities')).toBeUndefined()

    map.styleLoaded = true
    map.fire('style.load')
    map.fire('load')

    expect(map.getLayer('layer-facilities')).toBeTruthy()
    expect(map.droppedLayers).toEqual([])
  })

  it('re-renders shelter points after clear_map wipes the layers', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    await Effect.runPromise(adapter.clear())

    expect(map.layerIds()).not.toContain('layer-facilities-halo')
    expect(map.getSource('src-facilities')).toBeUndefined()
    expect(await Effect.runPromise(adapter.readAllLayers())).toEqual([])

    await Effect.runPromise(adapter.setLayer('facilities', shelters))

    for (const lid of SHELTER_LAYERS) {
      expect(map.getLayer(lid), `${lid} must be rebuilt after clear()`).toBeTruthy()
    }
    expect(map.getSource('src-facilities')?.data).toBe(shelters)
  })

  it('clears every layer even when one source removal fails', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    await Effect.runPromise(adapter.setLayer('routes', floodZones))

    // Simulate a source MapLibre refuses to drop; teardown must still finish.
    map.layers.push({ id: 'third-party-pin', source: 'src-facilities' })

    await Effect.runPromise(adapter.clear())

    expect(map.layerIds()).not.toContain('layer-routes')
    expect(map.getSource('src-routes')).toBeUndefined()
    expect(await Effect.runPromise(adapter.readAllLayers())).toEqual([])
  })

  it('rebuilds missing shelter layers when the source outlived them', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    // Source survives, render layers do not — the state a partial teardown leaves behind.
    for (const lid of SHELTER_LAYERS) map.removeLayer(lid)

    await Effect.runPromise(adapter.setLayer('facilities', shelters))

    for (const lid of SHELTER_LAYERS) {
      expect(map.getLayer(lid), `${lid} must be restored`).toBeTruthy()
    }
  })

  it('draws shelters above flood polygons regardless of update order', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    await Effect.runPromise(adapter.setLayer('flood-zones', floodZones))

    const order = map.layerIds()
    expect(order.indexOf('layer-facilities')).toBeGreaterThan(order.indexOf('layer-flood-zones-fill'))
    // Halo sits under its own solid core, label above both.
    expect(order.indexOf('layer-facilities-halo')).toBeLessThan(order.indexOf('layer-facilities'))
    expect(order.indexOf('layer-facilities')).toBeLessThan(order.indexOf('layer-facilities-label'))
  })

  it('colours shelter points by risk and labels them by name', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))

    expect(styleProp(map, 'layer-facilities', 'paint', 'circle-color')).toEqual([
      'match',
      ['get', 'risk'],
      'clear',
      '#16a34a',
      'at_risk',
      '#dc2626',
      'unknown',
      '#eab308',
      '#16a34a',
    ])

    expect(styleProp(map, 'layer-facilities-label', 'layout', 'text-field')).toEqual(['get', 'name'])
    // CJK shelter names need a locally rasterised font; the remote glyph server has no CJK ranges.
    expect(map.opts.localIdeographFontFamily).toContain('Noto Sans CJK JP')
  })

  it('hides and restores every shelter sublayer on toggle (R5.2)', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    await Effect.runPromise(adapter.toggleLayer('facilities', false))

    for (const lid of SHELTER_LAYERS) {
      expect(styleProp(map, lid, 'layout', 'visibility'), lid).toBe('none')
    }

    await Effect.runPromise(adapter.toggleLayer('facilities', true))

    for (const lid of SHELTER_LAYERS) {
      expect(styleProp(map, lid, 'layout', 'visibility'), lid).toBe('visible')
    }
  })

  it('opens exactly one shelter popup per click across layer rebuilds', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    await Effect.runPromise(adapter.clear())
    await Effect.runPromise(adapter.setLayer('facilities', shelters))

    map.fire('click:layer-facilities', {
      features: [shelters.features[0]],
      lngLat: { lng: 139.77, lat: 35.686 },
    })

    expect(popupsAdded).toHaveLength(1)
    expect(popupsAdded[0]).toContain('北部地区センター')
    expect(popupsAdded[0]).toContain('Safe (Clear)')
    expect(popupsAdded[0]).toContain('740 m')
  })

  it('escapes shelter names supplied by an upstream provider', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    map.fire('click:layer-facilities', {
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.77, 35.686] },
          properties: { name: '<img src=x onerror=alert(1)>', risk: 'clear' },
        },
      ],
      lngLat: { lng: 139.77, lat: 35.686 },
    })

    expect(popupsAdded[0]).not.toContain('<img')
    expect(popupsAdded[0]).toContain('&lt;img')
  })
})

describe('MapLibreAdapter route rendering (R3.*, R5.2)', () => {
  beforeEach(() => {
    createdMaps.length = 0
    popupsAdded.length = 0
  })

  it('renders routes as a casing and a coloured line bound to their source', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('routes', routes))

    for (const lid of ROUTE_LAYERS) {
      expect(map.getLayer(lid), `${lid} must exist`).toBeTruthy()
    }
    expect(map.droppedLayers).toEqual([])
    expect(map.getLayer('layer-routes')).toMatchObject({ type: 'line', source: 'src-routes' })
    expect(map.getSource('src-routes')?.data).toBe(routes)

    // Flood-avoidance state is the one thing a responder must read off the line itself — but only
    // on the route they are actually following; the alternatives are drawn plainly.
    const [branch, condition, activeColour, alternativeColour] = styleProp(
      map,
      'layer-routes',
      'paint',
      'line-color',
    ) as [string, unknown, unknown, unknown]
    expect(branch).toBe('case')
    expect(condition).toEqual(['==', ['get', 'rank'], 1])
    expect(activeColour).toEqual([
      'match',
      ['get', 'exclusions'],
      'unavoided',
      '#ea580c',
      'uncovered',
      '#ea580c',
      'unsupported',
      '#9333ea',
      '#2563eb',
    ])
    expect(alternativeColour).toBe('#94a3b8')
  })

  it('renders routes queued before the style finished loading', async () => {
    const adapter = new MapLibreAdapter({ container: document.createElement('div') })
    const map = createdMaps[createdMaps.length - 1]!

    await Effect.runPromise(adapter.setLayer('routes', routes))
    expect(map.getLayer('layer-routes')).toBeUndefined()

    map.styleLoaded = true
    map.fire('style.load')
    map.fire('load')

    for (const lid of ROUTE_LAYERS) expect(map.getLayer(lid), lid).toBeTruthy()
    expect(map.droppedLayers).toEqual([])
  })

  it('re-renders routes after clear_map wipes the layers', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('routes', routes))
    await Effect.runPromise(adapter.clear())

    expect(map.layerIds()).not.toContain('layer-routes-casing')
    expect(map.getSource('src-routes')).toBeUndefined()

    await Effect.runPromise(adapter.setLayer('routes', routes))

    for (const lid of ROUTE_LAYERS) {
      expect(map.getLayer(lid), `${lid} must be rebuilt after clear()`).toBeTruthy()
    }
  })

  it('draws the white casing beneath its route line, both above flood polygons', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('routes', routes))
    await Effect.runPromise(adapter.setLayer('flood-zones', floodZones))

    const order = map.layerIds()
    expect(order.indexOf('layer-routes-casing')).toBeLessThan(order.indexOf('layer-routes'))
    expect(order.indexOf('layer-routes-casing')).toBeGreaterThan(order.indexOf('layer-flood-zones-fill'))
    // Shelters mark the route endpoints, so they stay on top of the lines.
    await Effect.runPromise(adapter.setLayer('facilities', shelters))
    const withShelters = map.layerIds()
    expect(withShelters.indexOf('layer-routes')).toBeLessThan(withShelters.indexOf('layer-facilities'))
  })

  it('hides and restores both route sublayers on toggle (R5.2)', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('routes', routes))
    await Effect.runPromise(adapter.toggleLayer('routes', false))
    for (const lid of ROUTE_LAYERS) expect(styleProp(map, lid, 'layout', 'visibility'), lid).toBe('none')

    await Effect.runPromise(adapter.toggleLayer('routes', true))
    for (const lid of ROUTE_LAYERS) expect(styleProp(map, lid, 'layout', 'visibility'), lid).toBe('visible')
  })

  it('opens exactly one route popup per click across layer rebuilds', async () => {
    const { adapter, map } = mountLoadedAdapter()

    await Effect.runPromise(adapter.setLayer('routes', routes))
    await Effect.runPromise(adapter.clear())
    await Effect.runPromise(adapter.setLayer('routes', routes))

    map.fire('click:layer-routes', {
      features: [routes.features[1]],
      lngLat: { lng: 139.774, lat: 35.714 },
    })

    expect(popupsAdded).toHaveLength(1)
    expect(popupsAdded[0]).toContain('Route #2')
    expect(popupsAdded[0]).toContain('Ueno Onshi Park')
    expect(popupsAdded[0]).toContain('May Cross Flood Zone')
    expect(popupsAdded[0]).toContain('2 flood crossings')
  })
})

/**
 * The four checks the project's MapLibre testing guideline requires of every layer that renders
 * (§4.1): the layer exists, it is visible, its source holds the data, and a feature query returns
 * features with the expected properties.
 *
 * These exist because "routing is not displaying" was four indistinguishable failures wearing one
 * face — no data planned, no source, no layer, or a hidden one — and the map said nothing about
 * which. `inspectRendering` separates them, and separating them is what makes the report useful
 * at the moment it is needed.
 */
describe('reporting what the map actually drew (R3.11, guideline §4.1)', () => {
  beforeEach(() => {
    createdMaps.length = 0
    popupsAdded.length = 0
  })

  it('accounts for the route layer end to end: source, sublayers, visibility and drawn features', async () => {
    const { adapter } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', routes))

    const report = adapter.inspectRendering().find((r) => r.id === 'routes')
    expect(report).toBeDefined()
    if (!report) return

    // 1. Data binding: the source exists and holds what was published.
    expect(report.sourcePresent).toBe(true)
    expect(report.featureCount).toBe(routes.features.length)

    // 2. Layer existence: every sublayer the style declares is on the map.
    expect(report.renderLayers.every((l) => l.present)).toBe(true)
    expect(report.renderLayers.map((l) => l.id)).toEqual([...ROUTE_LAYERS])

    // 3. Visibility.
    expect(report.visible).toBe(true)
    expect(report.renderLayers.every((l) => l.visibility === 'visible')).toBe(true)

    // 4. Feature query: the lines reached the canvas, not merely the source.
    expect(report.renderedFeatureCount).toBeGreaterThan(0)
  })

  it('separates "no routes were planned" from "the routes did not render"', async () => {
    const { adapter } = mountLoadedAdapter()
    await Effect.runPromise(
      adapter.setLayer('routes', { type: 'FeatureCollection', features: [] }),
    )

    const report = adapter.inspectRendering().find((r) => r.id === 'routes')!
    // The layer is present and healthy; there was simply nothing to draw. That is the fixture-mode
    // failure this whole investigation started from, and it reads differently from a broken layer.
    expect(report.sourcePresent).toBe(true)
    expect(report.renderLayers.every((l) => l.present)).toBe(true)
    expect(report.featureCount).toBe(0)
    expect(report.renderedFeatureCount).toBe(0)
  })

  it('shows a hidden layer as holding its data but drawing none of it', async () => {
    const { adapter } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', routes))
    await Effect.runPromise(adapter.toggleLayer('routes', false))

    const report = adapter.inspectRendering().find((r) => r.id === 'routes')!
    expect(report.visible).toBe(false)
    expect(report.featureCount).toBe(routes.features.length)
    expect(report.renderLayers.every((l) => l.visibility === 'none')).toBe(true)
    expect(report.renderedFeatureCount).toBe(0)
  })

  it('reports the published layers in draw order, so an empty map can be read at a glance', () => {
    const { adapter } = mountLoadedAdapter()
    void Effect.runPromise(adapter.setLayer('facilities', shelters))
    void Effect.runPromise(adapter.setLayer('routes', routes))

    const report = adapter.inspectRendering()
    // Bottom to top, whatever order they were published in — the same order they are drawn.
    expect(report.map((r) => r.id)).toEqual(['routes', 'facilities'])
    expect(report.every((r) => r.sourcePresent)).toBe(true)
  })

  it('answers before the style has finished loading, rather than throwing', () => {
    const adapter = new MapLibreAdapter({ container: document.createElement('div') })
    void Effect.runPromise(adapter.setLayer('routes', routes))

    // The layer is queued, not rendered. A diagnostic that throws in the one state worth
    // diagnosing would be worse than none.
    expect(() => adapter.inspectRendering()).not.toThrow()
    const report = adapter.inspectRendering().find((r) => r.id === 'routes')!
    expect(report.featureCount).toBe(routes.features.length)
    expect(report.renderedFeatureCount).toBe(0)
  })
})

describe('only the route being followed is highlighted', () => {
  beforeEach(() => {
    createdMaps.length = 0
    popupsAdded.length = 0
  })

  const threeRoutes: FeatureCollection = {
    type: 'FeatureCollection',
    features: [1, 2, 3].map((rank) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[139.76, 35.68], [139.77, 35.69]] },
      properties: { rank, destination: `Shelter ${rank}`, exclusions: 'applied', metres: rank * 500 },
    })),
  }

  /** Evaluates one of our `['case', ['==', ['get','rank'], n], active, other]` paints. */
  const paintFor = (map: FakeMap, layerId: string, property: string, rank: number): unknown => {
    const expression = styleProp(map, layerId, 'paint', property) as
      | [string, [string, unknown, number], unknown, unknown]
      | unknown
    if (!Array.isArray(expression) || expression[0] !== 'case') return expression
    const [, condition, active, alternative] = expression as [string, [string, unknown, number], unknown, unknown]
    return condition[2] === rank ? active : alternative
  }

  it('opens on route 1, the safest the planner found', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))

    expect(adapter.getActiveRouteRank()).toBe(1)
    expect(paintFor(map, 'layer-routes', 'line-width', 1)).toBe(5)
    expect(paintFor(map, 'layer-routes', 'line-width', 2)).toBe(3)
  })

  it('draws the alternatives plainly and only the active one in colour', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))

    expect(paintFor(map, 'layer-routes', 'line-color', 2)).toBe('#94a3b8')
    expect(paintFor(map, 'layer-routes', 'line-color', 1)).toEqual(
      expect.arrayContaining(['match', ['get', 'exclusions']]),
    )
    expect(paintFor(map, 'layer-routes', 'line-opacity', 1)).toBe(0.95)
    expect(paintFor(map, 'layer-routes', 'line-opacity', 2)).toBe(0.45)
  })

  it('haloes the active route alone, so the options do not become a thicket', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))

    expect(paintFor(map, 'layer-routes-casing', 'line-opacity', 1)).toBe(0.65)
    expect(paintFor(map, 'layer-routes-casing', 'line-opacity', 2)).toBe(0)
    expect(paintFor(map, 'layer-routes-casing', 'line-opacity', 3)).toBe(0)
  })

  it('sorts the active route above the ones it crosses', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))

    const sortKey = styleProp(map, 'layer-routes', 'layout', 'line-sort-key') as [string, unknown, number, number]
    expect(sortKey[0]).toBe('case')
    expect(sortKey[2]).toBeGreaterThan(sortKey[3]!)
  })

  it('moves the highlight when another route is chosen', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))

    adapter.highlightRoute(3)

    expect(adapter.getActiveRouteRank()).toBe(3)
    expect(paintFor(map, 'layer-routes', 'line-width', 3)).toBe(5)
    expect(paintFor(map, 'layer-routes', 'line-width', 1)).toBe(3)
    expect(paintFor(map, 'layer-routes-casing', 'line-opacity', 3)).toBe(0.65)
    expect(paintFor(map, 'layer-routes-casing', 'line-opacity', 1)).toBe(0)
  })

  it('remembers the choice when the layer is rebuilt after a clear', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))
    adapter.highlightRoute(2)

    await Effect.runPromise(adapter.clear())
    await Effect.runPromise(adapter.setLayer('routes', threeRoutes))

    expect(paintFor(map, 'layer-routes', 'line-width', 2)).toBe(5)
  })

  it('is harmless before any route has been planned', () => {
    const { adapter } = mountLoadedAdapter()
    expect(() => adapter.highlightRoute(2)).not.toThrow()
    expect(adapter.getActiveRouteRank()).toBe(2)
  })
})

describe('MapLibre web worker wiring', () => {
  it('pins the worker URL to a bundler-emitted asset', () => {
    // MapLibre otherwise derives the worker URL from its own `import.meta.url`, which the bundler
    // rewrites to a path with no worker beside it. The worker then 404s and every GeoJSON source
    // stays unloaded: flood zones, shelters and routes all render nothing, silently.
    expect(workerUrls).toHaveLength(1)
    expect(workerUrls[0]).toBeTruthy()
    expect(workerUrls[0]).toMatch(/maplibre-gl-worker/)
  })
})

describe('MapPane clear control against a real MapLibre adapter (R5.2, R5.3)', () => {
  beforeEach(() => {
    createdMaps.length = 0
    popupsAdded.length = 0
  })

  it('brings shelter points back after the user clears the map and queries again', async () => {
    const { render, screen, waitFor } = await import('@testing-library/react')
    const userEvent = (await import('@testing-library/user-event')).default
    const { MapPane } = await import('../../ui/map/MapPane')

    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(
      adapter.setLayer('facilities', shelters, { attributions: ['指定緊急避難場所データ: 国土地理院'] }),
    )

    render(<MapPane mapPort={adapter} dataMode="fixture" />)

    await waitFor(() => {
      expect(screen.getByTestId('map-toggle-facilities')).toHaveTextContent('Safe Shelters')
    })
    expect(screen.getByTestId('map-toggle-facilities')).toHaveTextContent('(2)')

    await userEvent.click(screen.getByTestId('map-btn-clear'))

    await waitFor(() => {
      expect(screen.getByTestId('map-toggle-facilities')).not.toHaveTextContent('(2)')
    })
    expect(map.getLayer('layer-facilities')).toBeUndefined()

    // A follow-up shelter query must put the points back on the map surface.
    await Effect.runPromise(adapter.setLayer('facilities', shelters))

    for (const lid of SHELTER_LAYERS) {
      expect(map.getLayer(lid), `${lid} must render after clear + re-query`).toBeTruthy()
    }
    await waitFor(() => {
      expect(screen.getByTestId('map-toggle-facilities')).toHaveTextContent('(2)')
    })
  })
})

describe('framing the camera on a named target (R5.3)', () => {
  beforeEach(() => {
    createdMaps.length = 0
  })

  const floods: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[139.76, 35.68], [139.77, 35.68], [139.77, 35.69], [139.76, 35.68]]],
        },
        properties: { hazardClass: 'high' },
      },
    ],
  }

  const searched: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [136.2222, 36.0621] },
        properties: { name: '福井駅', kind: 'station' },
      },
    ],
  }

  it('frames the flood layer for the "floods" target', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('flood-zones', floods))
    const before = map.fitCalls

    await Effect.runPromise(adapter.focus('floods'))

    // The layer is called 'flood-zones' and the target 'floods'. Matching one against the other by
    // substring — which is what this did — framed nothing at all, silently.
    expect(map.fitCalls).toBe(before + 1)
  })

  it('frames a geocoded place for the "search" target', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('search-results', searched))
    const before = map.fitCalls

    await Effect.runPromise(adapter.focus('search'))

    expect(map.fitCalls).toBe(before + 1)
  })

  it('leaves the camera alone when the target names no layer that is loaded', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('flood-zones', floods))
    const before = map.fitCalls

    await Effect.runPromise(adapter.focus('routes'))

    expect(map.fitCalls).toBe(before)
  })
})

describe('flood zone colours come from one table (R5.7)', () => {
  beforeEach(() => {
    createdMaps.length = 0
  })

  const floodZones: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[136.22, 36.06], [136.23, 36.06], [136.23, 36.07], [136.22, 36.06]]],
        },
        properties: { hazardClass: 'extreme', depth: { minMetres: 5, maxMetres: 10 } },
      },
    ],
  }

  it('paints fill and outline from HAZARD_PALETTE, not from a second hand-written list', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('flood-zones', floodZones))

    expect(styleProp(map, 'layer-flood-zones-fill', 'paint', 'fill-color')).toEqual(
      hazardMatchExpression('fill'),
    )
    expect(styleProp(map, 'layer-flood-zones-line', 'paint', 'line-color')).toEqual(
      hazardMatchExpression('line'),
    )
  })

  it('gives every class the map can carry an arm of its own', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('flood-zones', floodZones))
    const expression = styleProp(map, 'layer-flood-zones-fill', 'paint', 'fill-color') as unknown[]

    for (const entry of HAZARD_PALETTE) {
      // The dark maroon of `extreme` reached the map long before the legend admitted it existed.
      expect(expression).toContain(entry.hazardClass)
      expect(expression).toContain(entry.fill)
    }
  })
})
