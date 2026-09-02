import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import type { FeatureCollection } from 'geojson'
import type { FloodZone } from '../../domain/hazard'
import { createdMaps } from './testing/maplibre-mock'
import { hatchImages } from '../../lib/hazard-palette'
import { inundationToFeatureCollection } from '../../app/hazard/inundation-model'
import fixture from './__fixtures__/inundation-zones.json'

vi.mock('maplibre-gl', async () => (await import('./testing/maplibre-mock')).maplibreModuleMock())

const { MapLibreAdapter } = await import('./maplibre')

/**
 * Do the model's inundation zones actually reach the canvas, in Europe and the United States?
 *
 * The other map suites drive the adapter with hand-written triangles. Real `/api/geo/flood-model`
 * output is nothing like that: four hazard classes, each a **MultiPolygon of hundreds to thousands
 * of disjoint parts** — 5 131 parts and 32 085 vertices in Carlisle's shallow band alone — because
 * the extent is vectorised from a raster and shallow water is speckle. That is the shape most
 * likely to be silently dropped somewhere between the route and the GPU, and until now nothing
 * exercised it.
 *
 * The fixture is that output, retrieved live on 2026-09-01 from a 20 km query at Carlisle and Cedar
 * Rapids, trimmed to a sample of each MultiPolygon's parts. Trimmed because the testing guidelines
 * forbid full-size production datasets in a suite; sampled across the parts rather than sliced off
 * the front so the many-part structure survives.
 *
 * **What this can and cannot prove.** It drives the adapter through the same `FakeMap` the rest of
 * the map suite uses, so it establishes that a source is created, that every render layer is added
 * and bound to it, that the layer is visible, and that `queryRenderedFeatures` returns the features
 * — the four checks §4.1 of the MapLibre testing guidelines asks for. It is **not** a pixel test:
 * jsdom has no WebGL, and this repository has no Playwright, so nothing here proves a colour
 * reached a screen. That tier is named in the guidelines and is not currently reachable.
 */

interface FixtureSite {
  readonly region: string
  readonly id: string
  readonly label: string
  readonly floodedAreaKm2: number
  readonly zones: ReadonlyArray<FloodZone>
}

const SITES = (fixture as { sites: ReadonlyArray<FixtureSite> }).sites

/** The `flood-zones` render layers, in the order `maplibre.ts` stacks them. */
const FLOOD_LAYERS = ['layer-flood-zones-fill', 'layer-flood-zones-hatch', 'layer-flood-zones-line']

/**
 * Exactly what `disaster.flood_forecast` puts on the map, reproduced here rather than imported:
 * the toolset builds this inline, so a copy is the only way to pin the shape the map is given.
 * If the two ever diverge, this suite is testing something the application does not do.
 */
const toFeatureCollection = (zones: ReadonlyArray<FloodZone>): FeatureCollection => ({
  type: 'FeatureCollection',
  features: zones.map((z) => ({
    type: 'Feature' as const,
    geometry: z.geometry,
    properties: { id: z.id, hazardClass: z.hazardClass, kind: z.kind.kind, depth: z.depth },
  })),
})

const mountLoadedAdapter = () => {
  const adapter = new MapLibreAdapter({ container: document.createElement('div') })
  const map = createdMaps[createdMaps.length - 1]!
  map.styleLoaded = true
  map.fire('load')
  return { adapter, map }
}

const floodReport = (adapter: InstanceType<typeof MapLibreAdapter>) => {
  const report = adapter.inspectRendering().find((r) => r.id === 'flood-zones')
  if (!report) throw new Error('no flood-zones layer was reported at all')
  return report
}

beforeEach(() => {
  createdMaps.length = 0
})

describe('inundation zones on the map', () => {
  it('has a fixture from both regions, with the many-part geometry that makes this worth testing', () => {
    expect(SITES.map((s) => s.region).sort()).toEqual(['EU', 'US'])
    for (const site of SITES) {
      expect(site.zones).toHaveLength(4)
      for (const zone of site.zones) {
        expect(zone.geometry.type).toBe('MultiPolygon')
        // A single-part polygon would not exercise what real output does.
        expect((zone.geometry as { coordinates: ReadonlyArray<unknown> }).coordinates.length).toBeGreaterThan(1)
      }
    }
  })

  for (const site of SITES) {
    describe(`${site.region} — ${site.label}`, () => {
      it('creates the source and binds every render layer to it', async () => {
        const { adapter, map } = mountLoadedAdapter()
        await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(site.zones)))

        const report = floodReport(adapter)
        expect(report.sourcePresent).toBe(true)
        expect(report.featureCount).toBe(4)
        expect(report.renderLayers.map((l) => l.id)).toEqual(FLOOD_LAYERS)
        for (const layer of report.renderLayers) {
          expect(layer.present).toBe(true)
          expect(layer.visibility).toBe('visible')
        }
        // Nothing was silently dropped for want of its source — the failure mode `FakeMap`
        // reproduces, and the one that leaves a real map blank without an error.
        expect(map.droppedLayers).toEqual([])
      })

      it('rasterises the zones rather than merely holding them in the source', async () => {
        const { adapter } = mountLoadedAdapter()
        await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(site.zones)))

        const report = floodReport(adapter)
        expect(report.visible).toBe(true)
        // Three render layers over four features: fill, hatch and outline each draw all four.
        expect(report.renderedFeatureCount).toBe(4 * FLOOD_LAYERS.length)
      })

      it('carries all four hazard classes and their depth bands to the source', async () => {
        const { adapter, map } = mountLoadedAdapter()
        await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(site.zones)))

        const data = map.sources.get('src-flood-zones')?.data as FeatureCollection
        const classes = data.features.map((f) => f.properties?.hazardClass).sort()
        expect(classes).toEqual(['extreme', 'high', 'low', 'moderate'])

        // The depth band is what the legend reads; losing it would render every class alike.
        for (const feature of data.features) {
          expect(feature.properties?.depth).toBeDefined()
          expect((feature.properties?.depth as { minMetres: number }).minMetres).toBeGreaterThanOrEqual(0)
        }
      })

      it('keeps every part of the multi-part geometry', async () => {
        const { adapter, map } = mountLoadedAdapter()
        const collection = toFeatureCollection(site.zones)
        await Effect.runPromise(adapter.setLayer('flood-zones', collection))

        const partsIn = collection.features.reduce(
          (sum, f) => sum + (f.geometry as { coordinates: ReadonlyArray<unknown> }).coordinates.length,
          0,
        )
        const data = map.sources.get('src-flood-zones')?.data as FeatureCollection
        const partsOut = data.features.reduce(
          (sum, f) => sum + (f.geometry as { coordinates: ReadonlyArray<unknown> }).coordinates.length,
          0,
        )
        expect(partsOut).toBe(partsIn)
        expect(partsOut).toBeGreaterThan(50)
      })

      /**
       * The control that makes `renderedFeatureCount` mean something. If it stayed non-zero with the
       * layer hidden, it would be reading the source rather than the canvas and every assertion
       * above would be worthless.
       */
      it('draws nothing once the layer is switched off', async () => {
        const { adapter } = mountLoadedAdapter()
        await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(site.zones)))
        expect(floodReport(adapter).renderedFeatureCount).toBeGreaterThan(0)

        await Effect.runPromise(adapter.toggleLayer('flood-zones', false))

        const hidden = floodReport(adapter)
        expect(hidden.visible).toBe(false)
        expect(hidden.renderedFeatureCount).toBe(0)
        // Still bound, just not drawn — the layer must come back on toggle without a reload.
        expect(hidden.sourcePresent).toBe(true)
        for (const layer of hidden.renderLayers) expect(layer.visibility).toBe('none')
      })

      it('puts the flood fill underneath the shelters and routes that must stay readable', async () => {
        const { adapter, map } = mountLoadedAdapter()
        await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(site.zones)))
        await Effect.runPromise(
          adapter.setLayer('facilities', {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [site.zones[0]!.geometry.type === 'MultiPolygon' ? 0 : 0, 0] },
                properties: { id: 'x', name: 'shelter', risk: 'clear' },
              },
            ],
          }),
        )

        const ids = map.layerIds()
        const lastFlood = Math.max(...FLOOD_LAYERS.map((l) => ids.indexOf(l)))
        const firstFacility = ids.findIndex((id) => id.startsWith('layer-facilities'))
        expect(firstFacility).toBeGreaterThan(lastFlood)
      })
    })
  }

  /**
   * The `inundation-model` layer is the one the model's own output is drawn on, through the same
   * converter the toolset uses. It exists apart from `flood-zones` because a screening estimate
   * and an authority's hazard map must not be indistinguishable once both are polygons on a canvas.
   */
  describe('the modelled-inundation layer', () => {
    const MODEL_LAYERS = [
      'layer-inundation-model-fill',
      'layer-inundation-model-hatch',
      'layer-inundation-model-line',
    ]

    it('registers every depth hatch before any patterned layer is drawn', async () => {
      const { map } = mountLoadedAdapter()

      // A `fill-pattern` naming an image the map does not hold draws nothing at all — not even the
      // fill beneath it — and MapLibre only warns. Registration has to precede the layer.
      expect([...map.images.keys()].sort()).toEqual(
        hatchImages()
          .map((h) => h.id)
          .sort(),
      )
      for (const { id, image } of hatchImages()) {
        const registered = map.images.get(id)!
        expect(registered.width).toBe(image.width)
        expect(registered.data.length).toBe(image.width * image.height * 4)
      }
    })

    it('renders the model output on its own layer, not on flood-zones', async () => {
      const { adapter } = mountLoadedAdapter()
      await Effect.runPromise(
        adapter.setLayer('inundation-model', inundationToFeatureCollection(SITES[0]!.zones)),
      )

      const reports = adapter.inspectRendering()
      const model = reports.find((r) => r.id === 'inundation-model')
      expect(model?.sourcePresent).toBe(true)
      expect(model?.renderLayers.map((l) => l.id)).toEqual(MODEL_LAYERS)
      expect(model?.renderedFeatureCount).toBe(4 * MODEL_LAYERS.length)
      // The authority's layer was not touched.
      expect(reports.find((r) => r.id === 'flood-zones')).toBeUndefined()
    })

    it('marks the modelled extent with a dashed edge and the surveyed one without', async () => {
      const { adapter, map } = mountLoadedAdapter()
      await Effect.runPromise(
        adapter.setLayer('inundation-model', inundationToFeatureCollection(SITES[0]!.zones)),
      )
      await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(SITES[0]!.zones)))

      const dash = (layerId: string) =>
        (map.getLayer(layerId)?.paint as Record<string, unknown> | undefined)?.['line-dasharray']
      expect(dash('layer-inundation-model-line')).toEqual([2, 2])
      expect(dash('layer-flood-zones-line')).toBeUndefined()
    })

    it('draws the modelled estimate beneath the authority’s hazard map', async () => {
      const { adapter, map } = mountLoadedAdapter()
      await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(SITES[0]!.zones)))
      await Effect.runPromise(
        adapter.setLayer('inundation-model', inundationToFeatureCollection(SITES[0]!.zones)),
      )

      const ids = map.layerIds()
      // Where the two disagree, the published map is the one that should be read.
      expect(Math.max(...MODEL_LAYERS.map((l) => ids.indexOf(l)))).toBeLessThan(
        Math.min(...FLOOD_LAYERS.map((l) => ids.indexOf(l))),
      )
    })

    it('carries the modelled flag onto every feature the map holds', async () => {
      const { adapter, map } = mountLoadedAdapter()
      await Effect.runPromise(
        adapter.setLayer('inundation-model', inundationToFeatureCollection(SITES[0]!.zones)),
      )

      const data = map.sources.get('src-inundation-model')?.data as FeatureCollection
      for (const feature of data.features) expect(feature.properties?.modelled).toBe(true)
    })

    it('can be switched off without disturbing the authority’s layer', async () => {
      const { adapter } = mountLoadedAdapter()
      await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(SITES[0]!.zones)))
      await Effect.runPromise(
        adapter.setLayer('inundation-model', inundationToFeatureCollection(SITES[0]!.zones)),
      )

      await Effect.runPromise(adapter.toggleLayer('inundation-model', false))

      const reports = adapter.inspectRendering()
      expect(reports.find((r) => r.id === 'inundation-model')?.renderedFeatureCount).toBe(0)
      expect(reports.find((r) => r.id === 'flood-zones')?.renderedFeatureCount).toBeGreaterThan(0)
    })
  })

  /**
   * A second query must replace the extent, not accumulate on top of it. Re-running the model over
   * a different place while the old polygons stayed on the map would show two floods at once.
   */
  it('replaces the previous extent when a second site is queried', async () => {
    const { adapter, map } = mountLoadedAdapter()
    await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(SITES[0]!.zones)))
    await Effect.runPromise(adapter.setLayer('flood-zones', toFeatureCollection(SITES[1]!.zones)))

    const report = floodReport(adapter)
    expect(report.featureCount).toBe(4)
    expect(map.layerIds().filter((id) => id === FLOOD_LAYERS[0]!)).toHaveLength(1)

    const data = map.sources.get('src-flood-zones')?.data as FeatureCollection
    const ids = data.features.map((f) => f.properties?.id)
    expect(ids).toEqual(SITES[1]!.zones.map((z) => z.id))
  })
})
