import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { planEvacuationRoutes, rankFacilities } from './routing-service'
import type { SafeFacility } from '../../domain/places'
import type { FloodZone } from '../../domain/hazard'
import { FixtureRoutingProvider } from '../../adapters/geo/fixture/fixture-routing'
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

  it('computes routes with crossing detection (R3.6, Checkpoint 6)', async () => {
    const routingPort = new FixtureRoutingProvider()
    const result = await Effect.runPromise(
      planEvacuationRoutes({
        origin,
        facilities,
        floodZones,
        hasFloodCoverage: true,
        routingPort,
        limit: 3,
      }),
    )

    expect(result.routes.length).toBe(3)
    expect(result.costing).toBe('pedestrian')
    // Check destination IDs match top ranked
    expect(result.routes[0]?.destination.id).toBe('fac-3')
    expect(result.routes[1]?.destination.id).toBe('fac-2')
    expect(result.routes[2]?.destination.id).toBe('fac-1')
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
