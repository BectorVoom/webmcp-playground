import { describe, expect, it } from 'vitest'
import type { FloodZone } from '../../domain/hazard'
import {
  countZonesVertices,
  dropSmallestPartsToBudget,
  fitZonesToMapBudget,
  simplifyZonesToBudget,
} from './simplify'

/**
 * A square part of a given side, in degrees, offset so parts do not overlap.
 * Five points because a GeoJSON ring closes — which is also the floor Douglas-Peucker cannot go
 * below, and therefore the whole reason this module exists.
 */
const square = (offset: number, side: number): Array<Array<[number, number]>> => [
  [
    [offset, 54.9],
    [offset + side, 54.9],
    [offset + side, 54.9 + side],
    [offset, 54.9 + side],
    [offset, 54.9],
  ],
]

const zoneOf = (
  hazardClass: FloodZone['hazardClass'],
  parts: ReadonlyArray<{ readonly offset: number; readonly side: number }>,
): FloodZone => ({
  id: `scenario-${hazardClass}`,
  kind: { kind: 'scenario', designEvent: 'test storm' },
  hazardClass,
  geometry: {
    type: 'MultiPolygon',
    coordinates: parts.map((p) => square(p.offset, p.side)),
  },
  provenance: {
    sourceId: 'estimate.fluvial.coupled',
    sourceName: 'Model estimate',
    upstreamUrl: 'https://example.invalid',
    retrievedAt: 1,
    cache: { hit: false, ageMs: 0 },
    licence: 'ODbL',
    attribution: 'test',
    mode: 'live',
  },
})

/** Many tiny parts plus one large one — the shape a vectorised flood extent actually has. */
const speckled = (count: number): FloodZone =>
  zoneOf('low', [
    { offset: -3.0, side: 0.05 },
    ...Array.from({ length: count }, (_, i) => ({ offset: -2.5 + i * 0.002, side: 0.0004 })),
  ])

describe('dropSmallestPartsToBudget', () => {
  /**
   * The defect this fixes. Douglas-Peucker will not take a ring below four points, so an extent of
   * *n* disjoint parts costs ~5n vertices at any tolerance — a real 20 km run is 7 685 parts and
   * lands at 38 725 vertices against a 20 000 budget with nothing left to simplify away.
   */
  it(
    'reaches a budget that simplification structurally cannot',
    () => {
      const zones = [speckled(6000)]
      const budget = 20_000

      const simplifiedOnly = simplifyZonesToBudget(zones, budget)
      expect(simplifiedOnly.verticesOut).toBeGreaterThan(budget)

      const fitted = fitZonesToMapBudget(zones, budget)
      expect(fitted.verticesOut).toBeLessThanOrEqual(budget)
      expect(fitted.partsOut).toBeLessThan(fitted.partsIn)
    },
    // The part count has to stay near the real 7 685 for 5n vertices to overrun
    // a 20 000 budget at all, and this is the one case that simplifies the whole
    // set twice. ~3 s alone, but past vitest's 5 s default when the suite runs
    // in parallel — which made it flaky rather than slow.
    30_000,
  )

  it('leaves geometry that already fits completely alone', () => {
    const zones = [zoneOf('high', [{ offset: -3, side: 0.05 }])]
    const result = dropSmallestPartsToBudget(zones, 20_000)

    expect(result.partsOut).toBe(result.partsIn)
    expect(result.areaDroppedKm2).toBe(0)
    expect(result.zones).toBe(zones)
  })

  /**
   * A depth band that vanished entirely would take its legend entry with it, and "no extreme water
   * here" is a very different claim from "the extreme water was too speckled to draw".
   */
  it('never drops a depth band entirely, however small its parts', () => {
    const zones = [speckled(4000), zoneOf('extreme', [{ offset: -2.0, side: 0.0003 }])]
    const result = dropSmallestPartsToBudget(zones, 200)

    expect(result.zones.map((z) => z.hazardClass)).toEqual(['low', 'extreme'])
    for (const zone of result.zones) {
      expect((zone.geometry as { coordinates: ReadonlyArray<unknown> }).coordinates.length).toBeGreaterThan(0)
    }
  })

  it('keeps the largest parts and drops the smallest', () => {
    const zones = [speckled(3000)]
    const result = dropSmallestPartsToBudget(zones, 500)

    // The big square is 0.05° a side against the speckles' 0.0004°; it must survive.
    const kept = (result.zones[0]!.geometry as unknown as { coordinates: Array<Array<Array<[number, number]>>> })
      .coordinates
    const sides = kept.map((poly) => Math.abs(poly[0]![1]![0] - poly[0]![0]![0]))
    expect(Math.max(...sides)).toBeCloseTo(0.05, 6)
  })

  /** Dropped fragments are real modelled water; the loss has to be quantified, not absorbed. */
  it('reports how much mapped area it removed', () => {
    const zones = [speckled(3000)]
    const result = dropSmallestPartsToBudget(zones, 500)

    expect(result.areaDroppedKm2).toBeGreaterThan(0)
    // Speckle, so the loss should be a small fraction of a big square's ~30 km².
    expect(result.areaDroppedKm2).toBeLessThan(5)
  })

  it('counts parts before and after', () => {
    const zones = [speckled(1000)]
    const result = dropSmallestPartsToBudget(zones, 500)

    expect(result.partsIn).toBe(1001)
    expect(result.partsOut).toBeLessThan(result.partsIn)
    expect(result.partsOut).toBeGreaterThan(0)
  })
})

describe('fitZonesToMapBudget', () => {
  it('simplifies before it drops, so a vertex is spent before a polygon is lost', () => {
    // Dense rings that simplification alone can bring inside the budget.
    const dense: FloodZone = zoneOf('moderate', [{ offset: -3, side: 0.05 }])
    const many = {
      ...dense,
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: Array.from({ length: 40 }, (_, r) => [
          Array.from({ length: 300 }, (_, i) => {
            const angle = (i / 300) * Math.PI * 2
            return [-3 + r * 0.01 + Math.cos(angle) * 0.004, 54.9 + Math.sin(angle) * 0.004] as [
              number,
              number,
            ]
          }).concat([[-3 + r * 0.01 + 0.004, 54.9]] as Array<[number, number]>),
        ]),
      },
    }

    const result = fitZonesToMapBudget([many], 20_000)
    expect(countZonesVertices(result.zones)).toBeLessThanOrEqual(20_000)
    // Simplification was enough, so nothing had to be thrown away.
    expect(result.partsOut).toBe(result.partsIn)
    expect(result.areaDroppedKm2).toBe(0)
  })

  it('reports vertices in and out across both steps', () => {
    const result = fitZonesToMapBudget([speckled(6000)], 20_000)

    expect(result.verticesIn).toBeGreaterThan(result.verticesOut)
    expect(result.verticesOut).toBe(countZonesVertices(result.zones))
  })
})
