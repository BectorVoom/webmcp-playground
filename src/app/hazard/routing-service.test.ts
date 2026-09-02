import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { planEvacuationRoutes, rankFacilities } from './routing-service'
import type { ExclusionState } from '../../domain/routing'
import type { SafeFacility } from '../../domain/places'
import type { FloodZone } from '../../domain/hazard'
import { FixtureRoutingProvider } from '../../adapters/geo/fixture/fixture-routing'
import { followsRoadNetwork } from '../../lib/geometry/road-network'
import { RoutingUnavailable } from '../../domain/geo-errors'
import type { RoutingPort } from '../../ports/Routing'

const mockProvenance = {
  sourceId: 'test.source',
  sourceName: 'Test Source',
  upstreamUrl: 'https://example.com',
  retrievedAt: Date.now(),
  cache: { hit: false, ageMs: 0 },
  licence: 'MIT',
  attribution: 'Test Attribution',
  mode: 'fixture' as const,
}

/**
 * Two properties decide whether a reader can trust the route they are shown: the one presented
 * first must be the safest found, and a route labelled as avoiding flood water must actually
 * avoid it. An engine's own claim is not evidence of the second.
 */
describe('choosing and labelling the safest path', () => {
  const provenance = {
    sourceId: 'test',
    sourceName: 'Test',
    upstreamUrl: 'https://example.com',
    retrievedAt: 0,
    cache: { hit: false, ageMs: 0 },
    licence: 'MIT',
    attribution: 'T',
    mode: 'fixture' as const,
  }

  const facility = (id: string, lat: number, lon: number, metres: number): SafeFacility => ({
    id,
    name: id,
    category: 'evacuation_site',
    at: { latitude: lat, longitude: lon },
    metres,
    bearing: 0,
    risk: 'clear',
    provenance,
  })

  // A band of standing water directly north of the origin.
  const floodZone: FloodZone = {
    id: 'z1',
    hazardClass: 'high',
    kind: { kind: 'scenario' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[139.46, 35.569], [139.47, 35.569], [139.47, 35.571], [139.46, 35.571], [139.46, 35.569]]],
    },
    provenance,
  } as unknown as FloodZone

  /** Straight-line routes, so whether one crosses the zone is decided purely by geography. */
  const engine = (): RoutingPort => ({
    sourceId: 'test.engine',
    meta: {
      sourceId: 'test.engine',
      sourceName: 'Test engine',
      docsUrl: 'https://example.com',
      licence: 'MIT',
      attribution: 'T',
      expectedRefreshMs: 1000,
    },
    route: (q) =>
      Effect.succeed({
        costing: q.costing,
        engineNotes: 'test',
        results: q.destinations.map((dest) => ({
          ok: true as const,
          route: {
            destination: dest,
            costing: q.costing,
            // Straight geometry, but declared as routed: these cases are about how the planner
            // ranks and labels what an engine hands back, not about verifying its shape.
            network: 'road' as const,
            metres: dest.metres,
            seconds: Math.round(dest.metres / 1.2),
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [q.origin.longitude, q.origin.latitude],
                [dest.at.longitude, dest.at.latitude],
              ],
            },
            steps: [],
            // The engine claims avoidance whenever it was asked, exactly as ours used to.
            exclusions: ((q.exclusions && q.exclusions.length > 0 ? 'applied' : 'not_requested') as ExclusionState),
            crossings: { count: 0, firstAtMetres: null, assessed: false, exposedMetres: 0 },
            engine: { name: 'valhalla' as const, costingNotes: 'test' },
            provenance,
          },
        })),
      }),
  })

  const origin = { latitude: 35.5677, longitude: 139.4637 }
  // Due north, straight through the flood band. Nearer than the clear option.
  const through = facility('through-flood', 35.5737, 139.4637, 700)
  // East, clear of the band, but further away.
  const around = facility('around-flood', 35.5677, 139.4737, 900)

  it('puts the route clear of flood water first, even when it is the longer one', async () => {
    const plan = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [through, around],
        floodZones: [floodZone],
        hasFloodCoverage: true,
        routingPort: engine(),
        limit: 2,
      }),
    )

    expect(plan.routes.map((r) => r.destination.id)).toEqual(['around-flood', 'through-flood'])
    expect(plan.routes[0]!.crossings.count).toBe(0)
    expect(plan.routes[1]!.crossings.count).toBeGreaterThan(0)
  })

  it('refuses to call a route flood-avoiding when its own geometry crosses the water', async () => {
    const plan = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [through],
        floodZones: [floodZone],
        hasFloodCoverage: true,
        routingPort: engine(),
      }),
    )

    // The engine said 'applied'; the geometry says otherwise, and the geometry wins.
    expect(plan.routes[0]!.crossings.count).toBeGreaterThan(0)
    expect(plan.routes[0]!.exclusions).toBe('unavoided')
    expect(plan.hasUnavoidedRoutes).toBe(true)
  })

  it('keeps the engine label when the route really does stay clear', async () => {
    const plan = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [around],
        floodZones: [floodZone],
        hasFloodCoverage: true,
        routingPort: engine(),
      }),
    )

    expect(plan.routes[0]!.crossings.count).toBe(0)
    expect(plan.routes[0]!.exclusions).toBe('applied')
    expect(plan.hasUnavoidedRoutes).toBe(false)
  })

  it('falls back to the shorter route when neither crosses water', async () => {
    const plan = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [around, facility('nearer-clear', 35.5677, 139.4707, 600)],
        floodZones: [floodZone],
        hasFloodCoverage: true,
        routingPort: engine(),
        limit: 2,
      }),
    )

    expect(plan.routes.map((r) => r.destination.id)).toEqual(['nearer-clear', 'around-flood'])
  })

  it('does not claim avoidance when avoidance was never requested', async () => {
    const plan = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [through],
        floodZones: [floodZone],
        hasFloodCoverage: true,
        routingPort: engine(),
        avoidFlood: false,
      }),
    )

    expect(plan.routes[0]!.exclusions).toBe('not_requested')
  })
})

describe('Routing Service (Phase 6, Checkpoint 6)', () => {
  const origin = { latitude: 35.6812, longitude: 139.7671 }

  const facilities: ReadonlyArray<SafeFacility> = [
    {
      id: 'fac-1',
      name: 'Hibiya Park (At Risk)',
      category: 'evacuation_site',
      at: { latitude: 35.674, longitude: 139.756 },
      metres: 850,
      bearing: 220,
      risk: 'at_risk',
      provenance: mockProvenance,
    },
    {
      id: 'fac-2',
      name: 'Shiba Park (Clear, Farther)',
      category: 'evacuation_site',
      at: { latitude: 35.655, longitude: 139.749 },
      metres: 2900,
      bearing: 200,
      risk: 'clear',
      provenance: mockProvenance,
    },
    {
      id: 'fac-3',
      name: 'Kitanomaru (Clear, Closer)',
      category: 'evacuation_site',
      at: { latitude: 35.692, longitude: 139.751 },
      metres: 1800,
      bearing: 310,
      risk: 'clear',
      provenance: mockProvenance,
    },
    {
      id: 'fac-4',
      name: 'Unknown Risk Facility',
      category: 'public_facility',
      at: { latitude: 35.700, longitude: 139.760 },
      metres: 2100,
      bearing: 350,
      risk: 'unknown',
      provenance: mockProvenance,
    },
  ]

  const floodZones: ReadonlyArray<FloodZone> = [
    {
      id: 'fz-1',
      kind: { kind: 'scenario', designEvent: 'L2' },
      hazardClass: 'high',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.755, 35.673],
            [139.765, 35.673],
            [139.765, 35.680],
            [139.755, 35.680],
            [139.755, 35.673],
          ],
        ],
      },
      provenance: mockProvenance,
    },
  ]

  it('ranks destinations clear -> at_risk -> unknown, then distance (R3.2, 6.5)', () => {
    const ranked = rankFacilities(facilities)
    expect(ranked[0]?.id).toBe('fac-3') // Clear, 1800m
    expect(ranked[1]?.id).toBe('fac-2') // Clear, 2900m
    expect(ranked[2]?.id).toBe('fac-1') // At Risk, 850m (kept, not dropped!)
    expect(ranked[3]?.id).toBe('fac-4') // Unknown, 2100m
  })

  /**
   * The recorded replies are keyed to real Tokyo shelters; `fac-*` above are invented, so they
   * exercise the planner's ranking rather than its road geometry. These use the real ones.
   */
  const recorded = (id: string, name: string, lat: number, lon: number, metres: number): SafeFacility => ({
    id,
    name,
    category: 'evacuation_site',
    at: { latitude: lat, longitude: lon },
    metres,
    bearing: 200,
    risk: 'clear',
    provenance: mockProvenance,
  })

  const hibiya = recorded('jp-fac-1', 'Hibiya Park', 35.674, 139.756, 1300)
  const forum = recorded('jp-fac-2', 'Tokyo International Forum', 35.677, 139.764, 550)
  // The upstream engine cannot serve this pair, so nothing was recorded for it.
  const shiba = recorded('jp-fac-3', 'Shiba Park', 35.655, 139.749, 3300)

  it('computes routes with crossing detection (R3.6, Checkpoint 6)', async () => {
    const routingPort = new FixtureRoutingProvider()
    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [hibiya, forum],
        floodZones,
        hasFloodCoverage: true,
        routingPort,
        limit: 2,
      }),
    )

    expect(result.costing).toBe('pedestrian')
    expect(result.routes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(result.routes.map((r) => r.destination.id))).toEqual(
      new Set(['jp-fac-1', 'jp-fac-2']),
    )
    for (const route of result.routes) {
      expect(route.crossings.assessed).toBe(true)
    }
  })

  it('never offers a straight line as a route, only as a distance (R3.1)', async () => {
    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [forum, shiba],
        floodZones,
        hasFloodCoverage: true,
        routingPort: new FixtureRoutingProvider(),
        limit: 2,
      }),
    )

    // Every drawn route follows roads...
    expect(result.routes.length).toBeGreaterThan(0)
    for (const route of result.routes) {
      expect(route.network).toBe('road')
      expect(followsRoadNetwork(route.geometry)).toBe(true)
    }
    // ...and the destination with no path to it is a distance, not a line on the map.
    expect(result.routes.map((r) => r.destination.id)).not.toContain('jp-fac-3')
    expect(result.straightLineFallback?.map((f) => f.facility.id)).toEqual(['jp-fac-3'])
  })

  it('offers several ways round to one destination, safest first (R3.9)', async () => {
    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [forum],
        floodZones,
        hasFloodCoverage: true,
        routingPort: new FixtureRoutingProvider(),
        limit: 1,
        candidatesPerDestination: 3,
      }),
    )

    expect(result.routes.length).toBeGreaterThan(1)
    for (const route of result.routes) expect(route.destination.id).toBe('jp-fac-2')

    // The candidates are genuinely different paths, not the same one repeated.
    const shapes = new Set(result.routes.map((r) => JSON.stringify(r.geometry.coordinates)))
    expect(shapes.size).toBe(result.routes.length)

    // Ranked by how much of each runs through water, and the leader is the recommendation.
    const exposure = result.routes.map((r) => r.crossings.exposedMetres)
    expect([...exposure].sort((a, b) => a - b)).toEqual(exposure)
    expect(result.recommendedExposedMetres).toBe(exposure[0])
  })

  it('keeps every destination on the map before adding second ways round (R3.9)', async () => {
    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [hibiya, forum],
        floodZones,
        hasFloodCoverage: true,
        routingPort: new FixtureRoutingProvider(),
        limit: 2,
        candidatesPerDestination: 3,
      }),
    )

    expect(new Set(result.routes.map((r) => r.destination.id))).toEqual(
      new Set(['jp-fac-1', 'jp-fac-2']),
    )
    // Six candidates were available; the map is not asked to draw more than it can distinguish.
    expect(result.routes.length).toBeLessThanOrEqual(6)
  })

  it('never drops a destination to make room for another one’s alternatives', async () => {
    const many = [
      hibiya,
      forum,
      recorded('jp-fac-4', 'Kitanomaru National Park', 35.692, 139.751, 2500),
      recorded('jp-fac-5', 'Ueno Onshi Park Safe Area', 35.714, 139.774, 4100),
      recorded('jp-fac-6', 'Chiyoda Public Safety Complex', 35.694, 139.753, 2600),
    ]

    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: many,
        floodZones,
        hasFloodCoverage: true,
        routingPort: new FixtureRoutingProvider(),
        limit: many.length,
        candidatesPerDestination: 3,
      }),
    )

    // Fifteen candidates were available and the cap is six, but a shelter that can be reached is
    // never left off the map to make room for a second way round to another one.
    expect(new Set(result.routes.map((r) => r.destination.id)).size).toBe(many.length)
    expect(result.routes.length).toBeLessThan(many.length * 3)
  })

  it('falls back to straight-line distances when routing engine fails (R3.8, 6.7)', async () => {
    const failingPort: RoutingPort = {
      sourceId: 'broken.engine',
      meta: {
        sourceId: 'broken.engine',
        sourceName: 'Broken Engine',
        docsUrl: 'https://example.com',
        licence: 'MIT',
        attribution: 'Test',
      },
      route: () => Effect.fail(new RoutingUnavailable({ engine: 'valhalla', message: 'Engine offline' })),
    }

    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities,
        floodZones,
        hasFloodCoverage: true,
        routingPort: failingPort,
        limit: 3,
      }),
    )

    expect(result.routes.length).toBe(0)
    expect(result.straightLineFallback).toBeDefined()
    expect(result.straightLineFallback?.length).toBe(3)
    expect(result.engineNotes).toContain('Straight-line distances')
  })

  it('handles empty facility list gracefully (R3.10, 6.8)', async () => {
    const routingPort = new FixtureRoutingProvider()
    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities: [],
        floodZones,
        hasFloodCoverage: true,
        routingPort,
      }),
    )

    expect(result.routes.length).toBe(0)
    expect(result.engineNotes).toContain('No facilities within radius')
  })
})
