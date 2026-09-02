import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { FixtureRoutingProvider } from './fixture-routing'
import { assessRoadAdherence, describeRoadAdherence } from '../../../lib/geometry/road-network'
import type { SafeFacility } from '../../../domain/places'
import type { RouteQuery } from '../../../ports/Routing'

/**
 * Every path this provider hands out is either a recording of a real engine reply or an admitted
 * straight line, and the two must never be confused for one another. These check exactly that,
 * against the recordings actually shipped: if a future capture is taken badly — a crow-flight, a
 * route decoded at the wrong precision — the drawn line stops following streets, and this is
 * where that is caught rather than in the field.
 */

const provenance = {
  sourceId: 's',
  sourceName: 'S',
  upstreamUrl: 'https://example.com',
  retrievedAt: 0,
  cache: { hit: false, ageMs: 0 },
  licence: 'MIT',
  attribution: 'T',
  mode: 'fixture' as const,
}

const facility = (id: string, name: string, lat: number, lon: number): SafeFacility => ({
  id,
  name,
  category: 'evacuation_site',
  at: { latitude: lat, longitude: lon },
  metres: 1000,
  bearing: 200,
  risk: 'clear',
  provenance,
})

/** Where the recordings were captured, and the shelters they were captured to. */
const TOKYO_STATION = { latitude: 35.6812, longitude: 139.7671 }
const RECORDED = [
  facility('jp-fac-1', 'Hibiya Park Evacuation Site', 35.674, 139.756),
  facility('jp-fac-2', 'Tokyo International Forum', 35.677, 139.764),
  facility('jp-fac-4', 'Kitanomaru National Park', 35.692, 139.751),
  facility('jp-fac-5', 'Ueno Onshi Park Safe Area', 35.714, 139.774),
  facility('jp-fac-6', 'Chiyoda Public Safety Complex', 35.694, 139.753),
]
/** The upstream engine returns a 500 for this pair, so nothing could be recorded for it. */
const UNRECORDED = facility('jp-fac-3', 'Shiba Park Disaster Base', 35.655, 139.749)

const run = (query: RouteQuery) => Effect.runPromise(new FixtureRoutingProvider().route(query))

describe('the routes shipped in fixture mode follow real roads', () => {
  it('traces every recorded candidate along the street network', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: RECORDED,
      costing: 'pedestrian',
      candidatesPerDestination: 3,
    })

    const routes = result.results.flatMap((r) => (r.ok ? [r.route] : []))
    expect(routes.length).toBe(RECORDED.length * 3)

    for (const route of routes) {
      const report = assessRoadAdherence(route.geometry)
      // Named in the message so a bad capture says which route and why, not just "false".
      expect(
        report.followsRoadNetwork,
        `${route.destination.name}: ${describeRoadAdherence(report)}`,
      ).toBe(true)
      expect(route.network).toBe('road')
    }
  })

  it('bends round what lies between rather than going straight at it', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: RECORDED,
      costing: 'pedestrian',
    })

    for (const r of result.results) {
      if (!r.ok) continue
      const report = assessRoadAdherence(r.route.geometry)
      // A path along streets is always longer than the line between its endpoints, and carries a
      // shape point every few dozen metres rather than every few hundred.
      expect(report.detourRatio).toBeGreaterThan(1.05)
      expect(report.metresPerVertex).toBeLessThan(100)
      expect(report.vertexCount).toBeGreaterThan(20)
    }
  })

  it('lands the geometry on Tokyo, so the polyline was decoded at the precision it was written at', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: [RECORDED[1]!],
      costing: 'pedestrian',
    })
    const route = result.results[0]
    if (!route?.ok) throw new Error('expected a recorded route')

    for (const [lon, lat] of route.route.geometry.coordinates) {
      expect(lon).toBeGreaterThan(139.6)
      expect(lon).toBeLessThan(139.9)
      expect(lat).toBeGreaterThan(35.5)
      expect(lat).toBeLessThan(35.85)
    }
  })

  it('carries the engine’s own street names and manoeuvres', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: [RECORDED[1]!],
      costing: 'pedestrian',
    })
    const route = result.results[0]
    if (!route?.ok) throw new Error('expected a recorded route')

    expect(route.route.steps.length).toBeGreaterThan(3)
    expect(route.route.steps.some((s) => (s.streetNames?.length ?? 0) > 0)).toBe(true)
    expect(route.route.steps.map((s) => s.maneuver)).toContain('arrive')
    // Every step can be put on the map, which is what makes the list clickable.
    expect(route.route.steps.every((s) => s.at !== undefined)).toBe(true)
  })

  it('offers genuinely different ways round, not the same path repeated', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: [RECORDED[3]!],
      costing: 'pedestrian',
      candidatesPerDestination: 3,
    })

    const shapes = result.results.map((r) => (r.ok ? JSON.stringify(r.route.geometry) : ''))
    expect(shapes).toHaveLength(3)
    expect(new Set(shapes).size).toBe(3)
  })

  it('returns one route when only one is asked for', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: [RECORDED[0]!],
      costing: 'pedestrian',
    })
    expect(result.results).toHaveLength(1)
  })
})

describe('what it does when it has no recording', () => {
  it('admits a straight line for a destination it never captured', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: [UNRECORDED],
      costing: 'pedestrian',
    })
    const route = result.results[0]
    if (!route?.ok) throw new Error('expected a straight-line result')

    expect(route.route.network).toBe('straight-line')
    expect(assessRoadAdherence(route.route.geometry).followsRoadNetwork).toBe(false)
    expect(route.route.engine.costingNotes).toMatch(/following no road/)
    expect(result.engineNotes).toMatch(/not paths/)
  })

  it('refuses to hand a Tokyo polyline to someone standing elsewhere', async () => {
    // Same shelter ids, a reader 30 km away: the recorded shape follows real streets, just not
    // any street near them.
    const result = await run({
      origin: { latitude: 35.5677, longitude: 139.4637 },
      destinations: RECORDED,
      costing: 'pedestrian',
    })

    for (const r of result.results) {
      if (!r.ok) continue
      expect(r.route.network).toBe('straight-line')
    }
    expect(result.engineNotes).toMatch(/no recorded route from this origin/)
  })

  it('still measures the distance and narrates it, so the fallback is usable', async () => {
    const result = await run({
      origin: TOKYO_STATION,
      destinations: [UNRECORDED],
      costing: 'pedestrian',
    })
    const route = result.results[0]
    if (!route?.ok) throw new Error('expected a straight-line result')

    expect(route.route.metres).toBeGreaterThan(2000)
    expect(route.route.seconds).toBeGreaterThan(0)
    expect(route.route.steps.length).toBeGreaterThan(0)
  })
})
