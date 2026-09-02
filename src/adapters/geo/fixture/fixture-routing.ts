import { Effect } from 'effect'
import type { LineString } from 'geojson'
import type { LonLat } from '../../../domain/geo'
import type { EvacuationRoute, ExclusionState, RouteStep } from '../../../domain/routing'
import { buildTurnByTurnSteps, metresBetween } from '../../../lib/geometry/directions'
import type { Provenance } from '../../../domain/provenance'
import type {
  DestinationRouteResult,
  RouteQuery,
  RoutingPort,
  RoutingQueryResult,
} from '../../../ports/Routing'
import type { ProviderMeta } from '../../../ports/FloodData'
import {
  parseRouteResponse,
  type ParsedTrip,
  type ValhallaRouteResponse,
} from '../routing/valhalla-trip'
import routingFixture from '../../../../fixtures/geo/global/routing/normal.json'

/**
 * Routing without the network, off replies recorded from the real engine.
 *
 * The recordings are verbatim Valhalla output and are read back through the same parser the live
 * adapter uses, so a fixture route follows Tokyo streets exactly as a live one does — a fixture
 * that drew a line straight across the Imperial Palace would be a rehearsal of nothing.
 *
 * Where there is no recording — an origin the capture does not cover, a destination the upstream
 * engine could not serve — this reports a straight-line distance and says so, rather than
 * inventing a path. See `synthesiseStraightLine`.
 */

interface FixtureCapture {
  readonly destinationId: string
  readonly costing: string
  readonly response: ValhallaRouteResponse
}

interface FixtureRoutingFile {
  readonly capturedAt: number
  readonly upstreamUrl: string
  readonly sourceId: string
  readonly licence: string
  readonly attribution: string
  readonly note: string
  readonly origin: { readonly latitude: number; readonly longitude: number }
  readonly originToleranceMetres: number
  readonly captures: ReadonlyArray<FixtureCapture>
}

/** Simulated walking pace, matching the pedestrian costing the recordings were made with. */
const WALK_METRES_PER_SECOND = 1.2

/**
 * The crow-flight line to a destination with no recorded route.
 *
 * Earlier this traced an L-shaped approach to make the guidance look like a walk through a street
 * grid. It looked convincing and was fiction: the corner it turned was wherever the arithmetic put
 * it, not a junction. Two points and an honest label is the smaller lie, and the planner keeps
 * such a path off the map entirely — it survives only as the distance-and-bearing fallback.
 */
const synthesiseStraightLine = (origin: LonLat, destination: LonLat): LineString => ({
  type: 'LineString',
  coordinates: [
    [origin.longitude, origin.latitude],
    [destination.longitude, destination.latitude],
  ],
})

export class FixtureRoutingProvider implements RoutingPort {
  readonly sourceId = 'global.fixture.routing'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Recorded Valhalla Routing Replies',
    docsUrl: 'https://valhalla.github.io/valhalla/',
    vintage: '2026-04-fixture',
    licence: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors, Valhalla routing engine (recorded)',
    expectedRefreshMs: 86_400_000,
  }

  private readonly data: FixtureRoutingFile = routingFixture as FixtureRoutingFile

  /**
   * A recording is only a route from the place it was recorded at. Handing a Tokyo polyline to
   * someone standing in Hamburg would draw a line that follows real streets in the wrong city.
   */
  private coversOrigin(origin: LonLat): boolean {
    return (
      metresBetween(origin, this.data.origin) <= this.data.originToleranceMetres
    )
  }

  route(query: RouteQuery): Effect.Effect<RoutingQueryResult, never> {
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: this.data.upstreamUrl,
      datasetVintage: '2026-04',
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'fixture',
    }

    const exclusionState: ExclusionState =
      query.exclusions && query.exclusions.length > 0 ? 'applied' : 'not_requested'

    const candidateLimit = Math.max(1, query.candidatesPerDestination ?? 1)
    const originCovered = this.coversOrigin(query.origin)
    const results: Array<DestinationRouteResult> = []
    let recordedCount = 0
    let straightLineCount = 0

    const asRoute = (
      destination: RouteQuery['destinations'][number],
      parsed: Pick<ParsedTrip, 'geometry' | 'steps' | 'metres' | 'seconds'>,
      network: EvacuationRoute['network'],
      costingNotes: string,
    ): EvacuationRoute => ({
      destination,
      costing: query.costing,
      network,
      metres: parsed.metres,
      seconds: parsed.seconds,
      geometry: parsed.geometry,
      steps: parsed.steps,
      exclusions: exclusionState,
      crossings: { count: 0, firstAtMetres: null, assessed: false, exposedMetres: 0 },
      engine: { name: 'valhalla', hostedBy: 'recorded', costingNotes },
      provenance,
    })

    for (const destination of query.destinations) {
      const capture = originCovered
        ? this.data.captures.find((c) => c.destinationId === destination.id)
        : undefined
      const parsedCandidates = capture ? parseRouteResponse(capture.response) : []

      if (parsedCandidates.length > 0) {
        for (const parsed of parsedCandidates.slice(0, candidateLimit)) {
          recordedCount += 1
          results.push({
            ok: true,
            route: asRoute(
              destination,
              parsed,
              'road',
              'Recorded pedestrian costing on the OSM road network. Road damage and submerged roads are not reflected.',
            ),
          })
        }
        continue
      }

      straightLineCount += 1
      const geometry = synthesiseStraightLine(query.origin, destination.at)
      const metres = Math.round(metresBetween(query.origin, destination.at))
      const seconds = Math.round(metres / WALK_METRES_PER_SECOND)
      const steps: ReadonlyArray<RouteStep> = buildTurnByTurnSteps({
        geometry,
        destinationName: destination.name,
        totalMetres: metres,
        totalSeconds: seconds,
        speedMetresPerSecond: WALK_METRES_PER_SECOND,
      })

      results.push({
        ok: true,
        route: asRoute(
          destination,
          { geometry, steps, metres, seconds },
          'straight-line',
          'No recorded route for this destination: straight-line distance only, following no road.',
        ),
      })
    }

    const notes = [
      `${recordedCount} recorded route(s) from the OSM road network.`,
      straightLineCount > 0
        ? `${straightLineCount} destination(s) have no recorded route${originCovered ? '' : ' from this origin'} and are reported as straight-line distances, not paths.`
        : '',
      'Real-time road damage or submerged roads are not reflected in baseline map data.',
    ].filter((part) => part !== '')

    return Effect.succeed({
      results,
      costing: query.costing,
      engineNotes: notes.join(' '),
    })
  }
}
