import { Effect } from 'effect'
import type { MultiPolygon, Polygon, Position } from 'geojson'
import type { GeoError } from '../../../domain/geo-errors'
import { describeGeoError, RoutingUnavailable } from '../../../domain/geo-errors'
import type { ExclusionState } from '../../../domain/routing'
import type {
  DestinationRouteResult,
  RouteQuery,
  RoutingPort,
  RoutingQueryResult,
} from '../../../ports/Routing'
import type { ProviderMeta } from '../../../ports/FloodData'
import { assessRoadAdherence, describeRoadAdherence } from '../../../lib/geometry/road-network'
import { FixtureRoutingProvider } from '../fixture/fixture-routing'
import {
  decodePolyline6,
  parseRouteResponse,
  type ParsedTrip,
  type ValhallaRouteResponse,
} from './valhalla-trip'

const API_BASE = '/api/geo'

/**
 * Named in failures. The engine inside is Valhalla, but "Valhalla is unavailable" sends a reader
 * looking at the wrong dashboard: what they configured, and what rejected them, is Stadia Maps.
 */
const ROUTING_SERVICE = 'stadia-maps'

export { decodePolyline6 }

/** Valhalla wants each excluded area as a single ring of [lon, lat]; holes are not expressible. */
export const toExcludePolygons = (
  exclusions: ReadonlyArray<Polygon | MultiPolygon>,
): Array<Array<Position>> => {
  const rings: Array<Array<Position>> = []
  for (const geometry of exclusions) {
    if (geometry.type === 'Polygon') {
      const ring = geometry.coordinates[0]
      if (ring && ring.length >= 4) rings.push(ring.map((p) => [p[0]!, p[1]!]))
    } else {
      for (const polygon of geometry.coordinates) {
        const ring = polygon[0]
        if (ring && ring.length >= 4) rings.push(ring.map((p) => [p[0]!, p[1]!]))
      }
    }
  }
  return rings
}

/**
 * Routing through Stadia Maps.
 *
 * Stadia runs Valhalla over OSM data, so every byte on the wire is Valhalla's — the request body,
 * the precision-six polyline, `alternates`, `exclude_polygons` — and `valhalla-trip.ts` parses it
 * unchanged. What Stadia adds is a hosted engine with a rate limit and an SLA behind it, which is
 * what a plan someone might evacuate on needs. The key stays on the server: this talks only to
 * `/api/geo/route`, and the proxy attaches it.
 */
export class StadiaRoutingProvider implements RoutingPort {
  readonly sourceId = 'global.stadia.routing'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Stadia Maps Routing (Valhalla)',
    docsUrl: 'https://docs.stadiamaps.com/api-reference/#tag/Routing',
    vintage: '2026-04',
    licence: 'ODbL 1.0',
    attribution: '© Stadia Maps, © OpenMapTiles, © OpenStreetMap contributors',
    expectedRefreshMs: 86_400_000,
  }

  private readonly fixture = new FixtureRoutingProvider()
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    // Wrapped rather than captured: `fetch` pulled off the global and called as a method throws
    // "Illegal invocation" in a browser, which is caught as a routing failure and silently drops
    // every live route back to the simulated one.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  /**
   * Routes each destination through the real engine, so the line follows the street network rather
   * than cutting across it, and flood zones are handed over as `exclude_polygons` for the engine
   * to route around properly.
   *
   * Where more than one candidate is asked for, the engine's alternatives come back alongside its
   * preferred trip — which is what gives the planner a way round a flooded street to choose from
   * rather than a single path to take or leave.
   *
   * Any destination the engine cannot serve — no network, the proxy not in live mode, a malformed
   * reply — falls back to the recorded provider rather than losing the route entirely. The
   * fallback keeps `mode: 'fixture'` in its provenance, so everything downstream keeps saying so.
   */
  route(query: RouteQuery): Effect.Effect<RoutingQueryResult, GeoError> {
    return Effect.gen(this, function* () {
      const excludePolygons = toExcludePolygons(query.exclusions ?? [])
      const results: Array<DestinationRouteResult> = []
      const servedIds = new Set<string>()
      // Why the live engine was not used, kept for the notes. A silent downgrade to recorded
      // routes reads as "the engine had nothing better", when the real answer is usually a
      // missing API key — and nothing else downstream would ever say so.
      let liveFailure: string | null = null

      for (const destination of query.destinations) {
        let honouredExclusions = excludePolygons.length > 0
        let live = yield* Effect.either(this.routeOne(query, destination.id, excludePolygons))

        // Excluding an area the walker is standing in leaves the engine nothing to start from, so
        // it refuses the whole route. A real road route that has to pass through water still beats
        // a straight line drawn over the rooftops — take it, and let the crossing check upstream
        // label it honestly as unavoided.
        if (live._tag === 'Left' && excludePolygons.length > 0) {
          honouredExclusions = false
          live = yield* Effect.either(this.routeOne(query, destination.id, []))
        }

        if (live._tag === 'Left') {
          liveFailure ??= describeGeoError(live.left)
          continue
        }

        servedIds.add(destination.id)
        for (const candidate of live.right) {
          results.push({
            ok: true,
            route: {
              destination,
              costing: query.costing,
              // Verified against the geometry in `routeOne`, not taken on the engine's word.
              network: 'road',
              metres: candidate.metres,
              seconds: candidate.seconds,
              geometry: candidate.geometry,
              steps: candidate.steps,
              // Claimed only where the engine actually accepted the polygons; whether the path
              // really stayed clear is re-checked against the geometry further up regardless.
              exclusions: (excludePolygons.length === 0
                ? 'not_requested'
                : honouredExclusions
                  ? 'applied'
                  : 'unavoided') as ExclusionState,
              crossings: { count: 0, firstAtMetres: null, assessed: false, exposedMetres: 0 },
              engine: {
                name: 'valhalla',
                hostedBy: 'stadia-maps',
                costingNotes: `Live ${query.costing} costing on the OSM road network, routed by Stadia Maps. Road damage and submerged roads are not reflected.`,
                dataVintage: this.meta.vintage,
              },
              provenance: {
                sourceId: this.meta.sourceId,
                sourceName: this.meta.sourceName,
                upstreamUrl: `${API_BASE}/route`,
                datasetVintage: this.meta.vintage,
                retrievedAt: Date.now(),
                cache: { hit: false, ageMs: 0 },
                licence: this.meta.licence,
                attribution: this.meta.attribution,
                mode: 'live',
              },
            },
          })
        }
      }

      if (servedIds.size === query.destinations.length && servedIds.size > 0) {
        return {
          results,
          costing: query.costing,
          engineNotes: `Routed on the OSM road network by Stadia Maps (Valhalla)${
            excludePolygons.length > 0
              ? `, with ${excludePolygons.length} flood area(s) excluded`
              : ''
          }. ${results.length} candidate route(s). Road damage and submerged roads are not reflected in baseline map data.`,
        }
      }

      // Some or all destinations were unreachable live; fall back for the rest so the plan stands.
      const recorded = yield* this.fixture.route(query)
      const why = liveFailure === null ? '' : ` Stadia Maps was not used: ${liveFailure}`

      if (servedIds.size === 0) {
        return { ...recorded, engineNotes: `${recorded.engineNotes}${why}` }
      }

      return {
        results: [
          ...results,
          ...recorded.results.filter((r) => !r.ok || !servedIds.has(r.route.destination.id)),
        ],
        costing: query.costing,
        engineNotes: `Mixed sources: ${servedIds.size} destination(s) from the live road network, the rest recorded. ${recorded.engineNotes}${why}`,
      }
    })
  }

  /** Every candidate the engine offers for one destination, best first. */
  private routeOne(
    query: RouteQuery,
    destinationId: string,
    excludePolygons: ReadonlyArray<ReadonlyArray<Position>>,
  ): Effect.Effect<ReadonlyArray<ParsedTrip>, GeoError> {
    const destination = query.destinations.find((d) => d.id === destinationId)!
    // Valhalla counts `alternates` on top of the trip it always returns.
    const alternates = Math.max(0, (query.candidatesPerDestination ?? 1) - 1)

    return Effect.gen(this, function* () {
      const body = {
        locations: [
          { lat: query.origin.latitude, lon: query.origin.longitude },
          { lat: destination.at.latitude, lon: destination.at.longitude },
        ],
        costing: query.costing,
        directions_options: { units: 'kilometers' },
        ...(alternates > 0 ? { alternates } : {}),
        ...(excludePolygons.length > 0 ? { exclude_polygons: excludePolygons } : {}),
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          this.fetchImpl(`${API_BASE}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            ...(query.signal ? { signal: query.signal } : {}),
          }),
        catch: (cause) =>
          new RoutingUnavailable({
            engine: ROUTING_SERVICE,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      })

      const payload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<ValhallaRouteResponse>,
        catch: () =>
          new RoutingUnavailable({ engine: ROUTING_SERVICE, message: 'Routing reply was not JSON' }),
      })

      const candidates = response.ok ? parseRouteResponse(payload) : []
      if (candidates.length === 0) {
        return yield* Effect.fail(
          new RoutingUnavailable({
            engine: ROUTING_SERVICE,
            message:
              payload.mode === 'fixture'
                ? 'Routing proxy is in fixture mode; set GEO_DATA_MODE=live to route on real roads'
                : (payload.message ??
                  payload.error ??
                  payload.trip?.status_message ??
                  'No route returned'),
          }),
        )
      }

      // The engine is asked for a path along roads; a reply that is a line between the endpoints
      // is not one, whatever it says. Rejecting it here is what keeps the promise the map makes —
      // that a drawn route is a route — from resting on an upstream service behaving itself.
      const onRoads = candidates.filter(
        (candidate) => assessRoadAdherence(candidate.geometry).followsRoadNetwork,
      )
      if (onRoads.length === 0) {
        const first = candidates[0]!
        return yield* Effect.fail(
          new RoutingUnavailable({
            engine: ROUTING_SERVICE,
            message: `Engine geometry does not follow the road network. ${describeRoadAdherence(assessRoadAdherence(first.geometry))}`,
          }),
        )
      }

      return onRoads
    })
  }
}
