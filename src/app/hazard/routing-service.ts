import { Effect } from 'effect'
import type { LonLat } from '../../domain/geo'
import type { FloodZone } from '../../domain/hazard'
import type { SafeFacility } from '../../domain/places'
import type { EvacuationRoute, ExclusionState, RouteCosting } from '../../domain/routing'
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
  /** Ways round to ask the engine for per destination. See `DEFAULT_CANDIDATES_PER_DESTINATION`. */
  readonly candidatesPerDestination?: number
}

export interface StraightLineFallbackItem {
  readonly facility: SafeFacility
  readonly metres: number
  readonly bearing: number
}

export interface EvacuationPlanResult {
  /** Candidates that follow the road network, safest first. Only these are drawn on the map. */
  readonly routes: ReadonlyArray<EvacuationRoute>
  /**
   * Destinations no engine could trace a path to. Present alongside `routes`, not only instead of
   * them: knowing a shelter is 400 m north-east still helps, and saying nothing about it does not.
   */
  readonly straightLineFallback?: ReadonlyArray<StraightLineFallbackItem>
  readonly engineNotes: string
  readonly costing: RouteCosting
  readonly hasUnavoidedRoutes: boolean
  readonly totalCrossings: number
  /** How far the recommended route runs through flood water; 0 when it stays clear. */
  readonly recommendedExposedMetres: number
}

/**
 * Ways round to ask for per destination. Three is what a navigation app offers, and it is the
 * point at which a genuinely different way round has usually appeared — which is what makes
 * choosing the driest one possible at all.
 */
const DEFAULT_CANDIDATES_PER_DESTINATION = 3

/**
 * Most candidates to draw at once. Past half a dozen lines the map stops showing a choice and
 * starts showing a thicket, and the recommendation is what gets lost in it.
 */
const MAX_ROUTE_CANDIDATES = 6

/**
 * Safest first, and only then shortest (R3.9).
 *
 * Distance spent in flood water leads, not the number of times the path meets a zone edge: one
 * crossing can mean stepping over the corner of a zone or wading three hundred metres, and it is
 * the wading that decides whether the route is survivable. A route whose flood exposure could not
 * be assessed sorts behind every route that was assessed and found clear, because an unknown is
 * not a clean bill of health.
 */
const UNASSESSED = Number.MAX_SAFE_INTEGER

export const compareRouteSafety = (a: EvacuationRoute, b: EvacuationRoute): number => {
  const exposureA = a.crossings.assessed ? a.crossings.exposedMetres : UNASSESSED
  const exposureB = b.crossings.assessed ? b.crossings.exposedMetres : UNASSESSED
  if (exposureA !== exposureB) return exposureA - exposureB

  const crossingsA = a.crossings.assessed ? a.crossings.count : UNASSESSED
  const crossingsB = b.crossings.assessed ? b.crossings.count : UNASSESSED
  if (crossingsA !== crossingsB) return crossingsA - crossingsB

  return a.metres - b.metres
}

/**
 * Trims the ranked candidates to what the map can usefully show, keeping every destination's best
 * option before adding second and third ways round to any one of them. A reader who asked for the
 * three nearest shelters should not lose two of them to alternatives for the first.
 *
 * The cap never costs a destination its route. Someone who asked for ten shelters gets all ten
 * that could be routed to; the cap only decides how many extra ways round are drawn on top. A
 * route computed and then silently left off the map is worse than a busy map, because nothing
 * downstream says it happened.
 */
export const selectRouteCandidates = (
  ranked: ReadonlyArray<EvacuationRoute>,
  maxCandidates = MAX_ROUTE_CANDIDATES,
): ReadonlyArray<EvacuationRoute> => {
  const destinationCount = new Set(ranked.map((r) => r.destination.id)).size
  const budget = Math.max(maxCandidates, destinationCount)

  const chosen: Array<EvacuationRoute> = []
  const represented = new Set<string>()

  for (const route of ranked) {
    if (represented.has(route.destination.id)) continue
    represented.add(route.destination.id)
    chosen.push(route)
  }

  const taken = new Set(chosen)
  for (const route of ranked) {
    if (chosen.length >= budget) break
    if (taken.has(route)) continue
    chosen.push(route)
  }

  return [...chosen].sort(compareRouteSafety)
}

/**
 * Names travel through a model and a user before they come back here, and every kind of space,
 * width and case drifts on the way: "指定緊急避難場所 (北部地区センター)" has to match
 * "指定緊急避難場所（北部地区センター）". NFKC folds the full-width forms together; stripping
 * spaces removes the rest of the variation.
 */
const normaliseFacilityName = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')

/**
 * Resolves a destination the user named to the facilities actually in range (R3.2).
 *
 * Without this the only way to ask for a route was to let the tool pick, so "route me to the
 * north district centre" had nowhere to go: the model saw only origin coordinates, read them as
 * the destination's, and gave up asking the user for latitude and longitude.
 */
export const findFacilitiesByName = (
  facilities: ReadonlyArray<SafeFacility>,
  query: string,
): ReadonlyArray<SafeFacility> => {
  const needle = normaliseFacilityName(query)
  if (needle === '') return []

  const byId = facilities.filter((f) => f.id === query.trim())
  if (byId.length > 0) return byId

  const exact = facilities.filter((f) => normaliseFacilityName(f.name) === needle)
  if (exact.length > 0) return exact

  // A model handed "指定緊急避難場所 (北部地区センター)" may pass back only the parenthesised part,
  // or a whole line copied out of an earlier tool result. Accept either containing the other.
  return facilities.filter((f) => {
    const name = normaliseFacilityName(f.name)
    return name.includes(needle) || needle.includes(name)
  })
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
 *
 * The result is a set of candidates ranked safest first, the way a navigation app offers a few
 * ways round: the map draws them all and highlights the leader, so the recommendation is visible
 * without the alternatives being hidden. Two rules keep it trustworthy — nothing that does not
 * follow the road network is offered as a route, and the leader is whichever candidate spends the
 * least of its length in flood water.
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
    candidatesPerDestination = DEFAULT_CANDIDATES_PER_DESTINATION,
  } = options

  if (facilities.length === 0) {
    return Effect.succeed({
      routes: [],
      engineNotes: 'No facilities within radius.',
      costing,
      hasUnavoidedRoutes: false,
      totalCrossings: 0,
      recommendedExposedMetres: 0,
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
        candidatesPerDestination,
        exclusions: exclusionGeometries.length > 0 ? exclusionGeometries : undefined,
      }),
    )

    let routeResults = initialAttempt._tag === 'Right' ? initialAttempt.right.results : []
    let engineNotes = initialAttempt._tag === 'Right' ? initialAttempt.right.engineNotes : ''
    let isFallbackToUnavoided = false

    /** A destination is served once some candidate for it actually follows roads. */
    const servedDestinationIds = (results: typeof routeResults): ReadonlySet<string> =>
      new Set(
        results
          .filter((r) => r.ok && r.route.network === 'road')
          .map((r) => (r.ok ? r.route.destination.id : '')),
      )

    const missingDestinations = selectedDestinations.filter(
      (dest) => !servedDestinationIds(routeResults).has(dest.id),
    )

    // 4. Fallback: retry without exclusions if needed (R3.5, ADR-6)
    if (
      initialAttempt._tag === 'Left' ||
      (missingDestinations.length > 0 && exclusionGeometries.length > 0)
    ) {
      const retryAttempt = yield* Effect.either(
        routingPort.route({
          origin,
          destinations: selectedDestinations,
          costing,
          candidatesPerDestination,
          exclusions: undefined,
        }),
      )

      if (retryAttempt._tag === 'Right') {
        routeResults = retryAttempt.right.results
        engineNotes = retryAttempt.right.engineNotes
        isFallbackToUnavoided = true
      }
    }

    // 5. Split what came back by whether it is a path at all (R3.1).
    //
    // A straight line between two points is a bearing and a distance, not a way to walk: drawing
    // one as a route is an instruction to cross whatever lies between. Those are held back for the
    // fallback list and never reach the map.
    const roadRoutes: Array<EvacuationRoute> = []
    const straightLineOnly = new Map<string, StraightLineFallbackItem>()

    for (const r of routeResults) {
      if (!r.ok) continue

      if (r.route.network !== 'road') {
        straightLineOnly.set(r.route.destination.id, {
          facility: r.route.destination,
          metres: r.route.destination.metres,
          bearing: r.route.destination.bearing,
        })
        continue
      }

      // Assess crossings on returned geometry (R3.6)
      const crossings = assessRouteCrossings(r.route.geometry, floodZones, hasFloodCoverage)

      // The engine's own claim is not evidence. Avoidance was asked for, so if the geometry it
      // returned still runs through a flood zone then the exclusions did not hold, whatever the
      // engine labelled it. Reporting "applied" over a route that crosses standing water is the
      // one error in this file a reader cannot recover from.
      const stillCrosses = crossings.assessed && crossings.count > 0
      const exclusions: ExclusionState =
        isFallbackToUnavoided || (avoidFlood && exclusionGeometries.length > 0 && stillCrosses)
          ? 'unavoided'
          : r.route.exclusions

      roadRoutes.push({ ...r.route, exclusions, crossings })
    }

    // 6. Safest first, then trimmed to what the map can show as a choice rather than a thicket.
    const rankedRoutes = [...roadRoutes].sort(compareRouteSafety)
    const candidates = selectRouteCandidates(rankedRoutes)

    // A destination with a real route needs no straight-line entry; one without keeps its own.
    for (const route of roadRoutes) straightLineOnly.delete(route.destination.id)
    for (const dest of selectedDestinations) {
      const served = roadRoutes.some((r) => r.destination.id === dest.id)
      if (!served && !straightLineOnly.has(dest.id)) {
        straightLineOnly.set(dest.id, { facility: dest, metres: dest.metres, bearing: dest.bearing })
      }
    }
    const straightLineFallback = [...straightLineOnly.values()]

    // 7. Engine-absent path (R3.8): nothing followed a road, so only distances can be offered.
    if (candidates.length === 0) {
      return {
        routes: [],
        straightLineFallback,
        engineNotes:
          engineNotes === ''
            ? 'Routing engine unavailable. Straight-line distances provided as fallback.'
            : `No candidate followed the road network, so no route is drawn. Straight-line distances only. ${engineNotes}`,
        costing,
        hasUnavoidedRoutes: false,
        totalCrossings: 0,
        recommendedExposedMetres: 0,
      }
    }

    const hasUnavoidedRoutes = candidates.some((r) => r.exclusions === 'unavoided')
    const totalCrossings = candidates.reduce((sum, r) => sum + r.crossings.count, 0)

    return {
      routes: candidates,
      ...(straightLineFallback.length > 0 ? { straightLineFallback } : {}),
      engineNotes,
      costing,
      hasUnavoidedRoutes,
      totalCrossings,
      recommendedExposedMetres: candidates[0]!.crossings.exposedMetres,
    }
  })
}
