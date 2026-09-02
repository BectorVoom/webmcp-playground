import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import type { FloodZone } from '../../domain/hazard'
import { MAP_VERTEX_BUDGET } from '../../lib/geometry/simplify'
import {
  fetchInundationModel,
  inundationToFeatureCollection,
  summariseInundationModel,
} from './inundation-model'

/**
 * A zone whose ring is dense enough to matter. Real model output reaches 68 000 vertices for a
 * 20 km query, so the question this suite exists for is whether that ever gets handed to a GPU.
 */
const zoneOf = (hazardClass: FloodZone['hazardClass'], rings: number, perRing: number): FloodZone => ({
  id: `scenario-${hazardClass}`,
  kind: { kind: 'scenario', designEvent: '200 mm / 48 h rainfall' },
  hazardClass,
  depth: { minMetres: 0.05, maxMetres: 0.5 },
  geometry: {
    type: 'MultiPolygon',
    coordinates: Array.from({ length: rings }, (_, r) => {
      // Closed, because a GeoJSON ring must be: turf's `simplify` throws on an open one, and
      // `simplifyZonesToBudget` catches that and returns the geometry untouched — so an open ring
      // here would quietly test nothing at all.
      const ring = Array.from({ length: perRing }, (_, i) => {
        const angle = (i / perRing) * Math.PI * 2
        return [-2.9 + r * 0.01 + Math.cos(angle) * 0.004, 54.9 + Math.sin(angle) * 0.004] as [
          number,
          number,
        ]
      })
      return [[...ring, ring[0]!]]
    }),
  },
  provenance: {
    sourceId: 'estimate.fluvial.coupled',
    sourceName: 'Model estimate',
    upstreamUrl: 'https://example.invalid/dem',
    retrievedAt: 1,
    cache: { hit: false, ageMs: 0 },
    licence: 'ODbL',
    attribution: 'Terrain Tiles by Mapzen/AWS Open Data',
    mode: 'live',
  },
})

const respondWith = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const modelBody = (zones: ReadonlyArray<FloodZone>, extra: Record<string, unknown> = {}) => ({
  inundation: { zones, floodedAreaKm2: 174.7 },
  climatology: { status: 'ok' },
  defences: { status: 'ok' },
  permanentWater: { status: 'ok' },
  limitations: ['Urban drainage is not modelled.'],
  ...extra,
})

const run = (body: unknown, status = 200) =>
  Effect.runPromise(
    fetchInundationModel(
      { at: { latitude: 54.9, longitude: -2.89 }, radiusKm: 20 },
      respondWith(body, status),
    ),
  )

describe('fetchInundationModel', () => {
  /**
   * The reason this module exists. `MAP_VERTEX_BUDGET` is 20 000 and real output is three times
   * that; handing the raw geometry to MapLibre is how the map stops responding rather than drawing
   * slowly, and nothing between the route and the canvas would otherwise trim it.
   */
  it('simplifies geometry that exceeds the map vertex budget', async () => {
    const heavy = [zoneOf('low', 60, 500), zoneOf('moderate', 60, 500)]
    const result = await run(modelBody(heavy))

    expect(result.verticesIn).toBeGreaterThan(MAP_VERTEX_BUDGET)
    expect(result.verticesOut).toBeLessThanOrEqual(MAP_VERTEX_BUDGET)
    expect(result.verticesOut).toBeLessThan(result.verticesIn)
    // Simplified, not discarded: every band must survive or the depth ramp loses a step.
    expect(result.zones.map((z) => z.hazardClass)).toEqual(['low', 'moderate'])
  })

  it('leaves geometry alone when it already fits', async () => {
    const light = [zoneOf('high', 2, 20)]
    const result = await run(modelBody(light))

    expect(result.verticesOut).toBe(result.verticesIn)
    expect(result.verticesIn).toBeLessThan(MAP_VERTEX_BUDGET)
  })

  it('reports the design event, area, attribution and input health', async () => {
    const result = await run(modelBody([zoneOf('high', 2, 20)]))

    expect(result.floodedAreaKm2).toBeCloseTo(174.7, 1)
    expect(result.designEvent).toContain('200 mm')
    expect(result.attributions).toEqual(['Terrain Tiles by Mapzen/AWS Open Data'])
    expect(result.inputs.every((i) => i.status === 'ok')).toBe(true)
    expect(result.limitations).toHaveLength(1)
  })

  it('carries a degraded input through rather than reporting a clean run', async () => {
    const result = await run(
      modelBody([zoneOf('high', 2, 20)], { defences: { status: 'overpass timeout' } }),
    )
    expect(result.inputs.find((i) => i.name === 'embankments')?.status).toBe('overpass timeout')
  })

  it('fails loudly on an HTTP error rather than drawing an empty extent', async () => {
    await expect(run({ error: 'boom' }, 500)).rejects.toThrow(/HTTP 500/)
  })

  it('fails on a body that is not JSON', async () => {
    const html = (async () => new Response('<html>gateway</html>', { status: 200 })) as unknown as typeof fetch
    await expect(
      Effect.runPromise(
        fetchInundationModel({ at: { latitude: 54.9, longitude: -2.89 }, radiusKm: 20 }, html),
      ),
    ).rejects.toThrow(/not JSON/)
  })

  it('treats a model that found no water as an answer, not a failure', async () => {
    const result = await run(modelBody([]))
    expect(result.zones).toEqual([])
    expect(result.floodedAreaKm2).toBeCloseTo(174.7, 1)
  })
})

describe('inundationToFeatureCollection', () => {
  it('marks every feature as modelled', async () => {
    const result = await run(modelBody([zoneOf('high', 2, 20)]))
    const collection = inundationToFeatureCollection(result.zones)

    expect(collection.features).toHaveLength(1)
    // A polygon that cannot say it is modelled is one that will be read as surveyed.
    expect(collection.features[0]!.properties?.modelled).toBe(true)
    expect(collection.features[0]!.properties?.hazardClass).toBe('high')
    expect(collection.features[0]!.properties?.depth).toBeDefined()
  })
})

describe('summariseInundationModel', () => {
  const summaryFor = async (extra: Record<string, unknown> = {}) => {
    const result = await run(modelBody([zoneOf('low', 60, 500)], extra))
    return summariseInundationModel({ result, radiusKm: 20, dataMode: 'live' })
  }

  /**
   * The area is the eye-catching number and the least trustworthy one. A summary that opens with
   * it invites it to be quoted as a finding, which is the specific harm this wording avoids.
   */
  it('leads with what the estimate is not, before what it says', async () => {
    const summary = await summaryFor()
    const firstLine = summary.split('\n')[0]!

    expect(firstLine).toMatch(/not an official hazard map/i)
    expect(firstLine.indexOf('174.7')).toBe(-1)
    expect(summary).toMatch(/over-predicts/i)
    // The measured over-prediction, so the caveat is a number rather than a hedge.
    expect(summary).toMatch(/1\.4–2\.1×|3–12×/)
  })

  it('says an authority’s map governs where one exists', async () => {
    expect(await summaryFor()).toMatch(/GSI, FEMA, Copernicus/)
  })

  it('admits when the drawn outline is coarser than the modelled one', async () => {
    const summary = await summaryFor()
    expect(summary).toMatch(/reduced for display/i)
    expect(summary).toMatch(/coarser than the/i)
  })

  it('names a degraded input instead of reporting the extent unqualified', async () => {
    const summary = await summaryFor({ permanentWater: { status: 'overpass 504' } })
    expect(summary).toMatch(/Degraded inputs/)
    expect(summary).toContain('standing water (overpass 504)')
  })

  it('marks a fixture-mode run as simulated', async () => {
    const result = await run(modelBody([zoneOf('low', 2, 20)]))
    const summary = summariseInundationModel({ result, radiusKm: 20, dataMode: 'fixture' })
    expect(summary).toMatch(/SIMULATED DATA/)
  })

  it('names the layer it drew on, so the reader can find it', async () => {
    expect(await summaryFor()).toContain("layer 'inundation-model'")
  })
})
