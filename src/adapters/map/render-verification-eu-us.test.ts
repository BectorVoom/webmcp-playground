import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson'
import { HAZARD_PALETTE } from '../../lib/hazard-palette'
import { createdMaps } from './testing/maplibre-mock'
import fixture from './__fixtures__/inundation-zones.json'

vi.mock('maplibre-gl', async () => (await import('./testing/maplibre-mock')).maplibreModuleMock())

const { MapLibreAdapter } = await import('./maplibre')

interface FixtureSite {
  readonly region: string
  readonly id: string
  readonly label: string
  readonly floodedAreaKm2: number
  readonly zones: ReadonlyArray<any>
}

const SITES = (fixture as { sites: ReadonlyArray<FixtureSite> }).sites

const toFeatureCollection = (zones: ReadonlyArray<any>): FeatureCollection => ({
  type: 'FeatureCollection',
  features: zones.map((z) => ({
    type: 'Feature' as const,
    geometry: z.geometry as (Polygon | MultiPolygon),
    properties: {
      id: z.id,
      hazardClass: z.hazardClass,
      kind: z.kind?.kind ?? 'inundation',
      depth: z.depth,
      severity: z.severity,
      depthM: z.depthM,
      depthLabel: z.depthLabel,
    },
  })),
})

const mountLoadedAdapter = () => {
  const adapter = new MapLibreAdapter({ container: document.createElement('div'), noBasemap: true })
  const map = createdMaps[createdMaps.length - 1]!
  map.styleLoaded = true
  map.fire('load')
  return { adapter, map }
}

beforeEach(() => {
  createdMaps.length = 0
})

describe('MapLibre GL JS Frontend Testing Guidelines (§4.1): Flood Zones Rendering in EU & America', () => {
  // 1. European Region: Carlisle (EU/UK)
  const euSite = SITES.find(s => s.region === 'EU' || s.id.includes('carlisle')) || SITES[0]!
  it(`renders European flood zones correctly (${euSite.label}) adhering to §4.1`, async () => {
    const { adapter, map } = mountLoadedAdapter()

    try {
      const collection = toFeatureCollection(euSite.zones)
      await Effect.runPromise(adapter.setLayer('flood-zones', collection))

      // 4.1.1 Layer Existence & Hierarchy
      const fillLayer = map.getLayer('layer-flood-zones-fill')
      const hatchLayer = map.getLayer('layer-flood-zones-hatch')
      const lineLayer = map.getLayer('layer-flood-zones-line')
      expect(fillLayer).toBeDefined()
      expect(hatchLayer).toBeDefined()
      expect(lineLayer).toBeDefined()

      // 4.1.2 Visibility State
      expect(map.getLayoutProperty('layer-flood-zones-fill', 'visibility')).not.toBe('none')
      expect(map.getLayoutProperty('layer-flood-zones-line', 'visibility')).not.toBe('none')

      // 4.1.3 Data Binding
      const data = map.sources.get('src-flood-zones')?.data as FeatureCollection
      expect(data).toBeDefined()
      expect(data.features.length).toBe(euSite.zones.length)

      // 4.1.4 Feature Inspection
      const reports = adapter.inspectRendering()
      const floodReport = reports.find(r => r.id === 'flood-zones')
      expect(floodReport?.renderedFeatureCount).toBeGreaterThan(0)
      expect(floodReport?.sourcePresent).toBe(true)

      // Symbology paint expression
      const fillExpression = fillLayer.paint['fill-color']
      expect(Array.isArray(fillExpression)).toBe(true)
      expect(fillExpression[0]).toBe('match')
    } finally {
      adapter.destroy()
    }
  })

  // 2. American Region: Cedar Rapids (US)
  const usSite = SITES.find(s => s.region === 'US' || s.id.includes('cedar-rapids')) || SITES[1]!
  it(`renders American flood zones correctly (${usSite.label}) adhering to §4.1`, async () => {
    const { adapter, map } = mountLoadedAdapter()

    try {
      const collection = toFeatureCollection(usSite.zones)
      await Effect.runPromise(adapter.setLayer('flood-zones', collection))

      // 4.1.1 Layer Existence & Hierarchy
      const fillLayer = map.getLayer('layer-flood-zones-fill')
      const hatchLayer = map.getLayer('layer-flood-zones-hatch')
      const lineLayer = map.getLayer('layer-flood-zones-line')
      expect(fillLayer).toBeDefined()
      expect(hatchLayer).toBeDefined()
      expect(lineLayer).toBeDefined()

      // 4.1.2 Visibility State
      expect(map.getLayoutProperty('layer-flood-zones-fill', 'visibility')).not.toBe('none')
      expect(map.getLayoutProperty('layer-flood-zones-line', 'visibility')).not.toBe('none')

      // 4.1.3 Data Binding
      const data = map.sources.get('src-flood-zones')?.data as FeatureCollection
      expect(data).toBeDefined()
      expect(data.features.length).toBe(usSite.zones.length)

      // 4.1.4 Feature Inspection
      const reports = adapter.inspectRendering()
      const floodReport = reports.find(r => r.id === 'flood-zones')
      expect(floodReport?.renderedFeatureCount).toBeGreaterThan(0)
      expect(floodReport?.sourcePresent).toBe(true)

      // 4.1.5 Interactive Layer Toggle
      await Effect.runPromise(adapter.toggleLayer('flood-zones', false))
      expect(map.getLayoutProperty('layer-flood-zones-fill', 'visibility')).toBe('none')

      await Effect.runPromise(adapter.toggleLayer('flood-zones', true))
      expect(map.getLayoutProperty('layer-flood-zones-fill', 'visibility')).toBe('visible')
    } finally {
      adapter.destroy()
    }
  })
})
