import { Effect } from 'effect'
import type { LonLat } from '../../domain/geo'
import type { FloodZone } from '../../domain/hazard'
import type { SafeFacility } from '../../domain/places'
import type { EvacuationRoute, RouteCosting } from '../../domain/routing'
import type { RoutingPort } from '../../ports/Routing'
import { simplifyZonesToBudget, ROUTING_VERTEX_BUDGET } from '../../lib/geometry/simplify'
import { assessRouteCrossings } from '../../lib/geometry/crossings'

export interface PlanEvacuationRoutesOptions {
  readonly origin: LonLat
  readonly facilities: ReadonlyArray<SafeFacility>
  readonly floodZones: ReadonlyArray<FloodZone>
  readonly hasFloodCoverage: boolean
  readonly routingPort: RoutingPort
  readonly costing?: RouteCosting
  readonly limit?: number
  readonly avoidFlood?: boolean
}

export interface StraightLineFallbackItem {
  readonly facility: SafeFacility
  readonly metres: number
  readonly bearing: number
}

export interface EvacuationPlanResult {
  readonly routes: ReadonlyArray<EvacuationRoute>
  readonly straightLineFallback?: ReadonlyArray<StraightLineFallbackItem>
  readonly engineNotes: string
  readonly costing: RouteCosting
  readonly hasUnavoidedRoutes: boolean
  readonly totalCrossings: number
}

/**
 * Ranks facilities: 'clear' -> 'at_risk' -> 'unknown', then by distance ascending (R3.2).
 */
export const rankFacilities = (
  facilities: ReadonlyArray<SafeFacility>,
): ReadonlyArray<SafeFacility> => {
  const riskPriority: Record<string, number> = {
    clear: 0,
    at_risk: 1,
    unknown: 2,
  }

  return [...facilities].sort((a, b) => {
    const pA = riskPriority[a.risk] ?? 3
    const pB = riskPriority[b.risk] ?? 3
    if (pA !== pB) return pA - pB
    return a.metres - b.metres
  })
}

/**
 * Plans evacuation routes using the routing port with exclusions and fallbacks (Phase 6, R3.1-R3.10).
 */
export const planEvacuationRoutes = (
  options: PlanEvacuationRoutesOptions,
): Effect.Effect<EvacuationPlanResult, never> => {
  const {
    origin,
    facilities,
    floodZones,
    hasFloodCoverage,
    routingPort,
    costing = 'pedestrian',
    limit = 3,
    avoidFlood = true,
  } = options

  if (facilities.length === 0) {
    return Effect.succeed({
      routes: [],
      engineNotes: 'No facilities within radius.',
      costing,
      hasUnavoidedRoutes: false,
      totalCrossings: 0,
    })
  }

  // 1. Destination ranking (R3.2)
  const ranked = rankFacilities(facilities)
  const selectedDestinations = ranked.slice(0, limit)

  // 2. Prepare exclusion polygons (R3.4)
  const simplifiedZones = avoidFlood && floodZones.length > 0
    ? simplifyZonesToBudget(floodZones, ROUTING_VERTEX_BUDGET).zones
    : []
  const exclusionGeometries = simplifiedZones.map((z) => z.geometry)

  return Effect.gen(function* () {
    // 3. Attempt routing with exclusions (R3.3, R3.4)
    const initialAttempt = yield* Effect.either(
      routingPort.route({
        origin,
        destinations: selectedDestinations,
        costing,
        exclusions: exclusionGeometries.length > 0 ? exclusionGeometries : undefined,
      }),
    )

    let routeResults = initialAttempt._tag === 'Right' ? initialAttempt.right.results : []
    let engineNotes = initialAttempt._tag === 'Right' ? initialAttempt.right.engineNotes : ''
    let isFallbackToUnavoided = false

    // Check if exclusions caused failure or missing routes
    const missingDestinations = selectedDestinations.filter(
      (dest) => !routeResults.some((r) => r.ok && r.route.destination.id === dest.id),
    )

    // 4. Fallback: retry without exclusions if needed (R3.5, ADR-6)
    if (initialAttempt._tag === 'Left' || (missingDestinations.length > 0 && exclusionGeometries.length > 0)) {
      const retryAttempt = yield* Effect.either(
        routingPort.route({
          origin,
          destinations: selectedDestinations,
          costing,
          exclusions: undefined,
        }),
      )

      if (retryAttempt._tag === 'Right') {
        routeResults = retryAttempt.right.results
        engineNotes = retryAttempt.right.engineNotes
        isFallbackToUnavoided = true
      }
    }

    // 5. Engine-absent path (R3.8): if routing failed completely, return straight-line distances
    const successfulRoutes: Array<EvacuationRoute> = []
    for (const r of routeResults) {
      if (r.ok) {
        // Assess crossings on returned geometry (R3.6)
        const crossings = assessRouteCrossings(r.route.geometry, floodZones, hasFloodCoverage)
        const exclusions = isFallbackToUnavoided ? 'unavoided' : r.route.exclusions

        successfulRoutes.push({
          ...r.route,
          exclusions,
          crossings,
        })
      }
    }

    if (successfulRoutes.length === 0) {
      const straightLineFallback: Array<StraightLineFallbackItem> = selectedDestinations.map((f) => ({
        facility: f,
        metres: f.metres,
        bearing: f.bearing,
      }))

      return {
        routes: [],
        straightLineFallback,
        engineNotes: 'Routing engine unavailable. Straight-line distances provided as fallback.',
        costing,
        hasUnavoidedRoutes: false,
        totalCrossings: 0,
      }
    }

    const hasUnavoidedRoutes = successfulRoutes.some((r) => r.exclusions === 'unavoided')
    const totalCrossings = successfulRoutes.reduce((sum, r) => sum + r.crossings.count, 0)

    return {
      routes: successfulRoutes,
      engineNotes,
      costing,
      hasUnavoidedRoutes,
      totalCrossings,
    }
  })
}
