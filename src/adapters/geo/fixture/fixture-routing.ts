import { Effect } from 'effect'
import type { LineString } from 'geojson'
import type { EvacuationRoute, ExclusionState, RouteStep } from '../../../domain/routing'
import type { Provenance } from '../../../domain/provenance'
import type { DestinationRouteResult, RouteQuery, RoutingPort, RoutingQueryResult } from '../../../ports/Routing'
import type { ProviderMeta } from '../../../ports/FloodData'
import routingFixture from '../../../../fixtures/geo/global/routing/normal.json'

interface FixtureRouteItem {
  readonly destinationId: string
  readonly costing: string
  readonly metres: number
  readonly seconds: number
  readonly steps: ReadonlyArray<RouteStep>
  readonly coordinates: ReadonlyArray<ReadonlyArray<number>>
}

interface FixtureRoutingFile {
  readonly capturedAt: number
  readonly upstreamUrl: string
  readonly sourceId: string
  readonly licence: string
  readonly attribution: string
  readonly routes: ReadonlyArray<FixtureRouteItem>
}

export class FixtureRoutingProvider implements RoutingPort {
  readonly sourceId = 'global.fixture.routing'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Simulated Valhalla Routing Provider',
    docsUrl: 'https://example.com/docs/fixture-routing',
    vintage: '2026-04-fixture',
    licence: 'Fixture Test Data',
    attribution: 'Simulated Routing Engine (Valhalla Pedestrian/Auto Model)',
    expectedRefreshMs: 86_400_000,
  }

  route(query: RouteQuery): Effect.Effect<RoutingQueryResult, never> {
    const rawData: FixtureRoutingFile = routingFixture

    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: rawData.upstreamUrl,
      datasetVintage: '2026-04',
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'fixture',
    }

    const exclusionState: ExclusionState =
      query.exclusions && query.exclusions.length > 0 ? 'applied' : 'not_requested'

    const results: Array<DestinationRouteResult> = []

    for (const dest of query.destinations) {
      const matched = rawData.routes.find((r) => r.destinationId === dest.id)

      const geometry: LineString = matched
        ? { type: 'LineString', coordinates: matched.coordinates as [number, number][] }
        : {
            type: 'LineString',
            coordinates: [
              [query.origin.longitude, query.origin.latitude],
              [dest.at.longitude, dest.at.latitude],
            ],
          }

      const metres = matched ? matched.metres : dest.metres
      const seconds = matched ? matched.seconds : Math.round(dest.metres / 1.2) // ~1.2 m/s walk speed

      const route: EvacuationRoute = {
        destination: dest,
        costing: query.costing,
        metres,
        seconds,
        geometry,
        steps: matched
          ? matched.steps
          : [
              {
                instruction: `Head straight toward ${dest.name}.`,
                metres,
                seconds,
              },
            ],
        exclusions: exclusionState,
        crossings: { count: 0, firstAtMetres: null, assessed: false },
        engine: {
          name: 'valhalla',
          costingNotes: 'Simulated pedestrian costing. Road network ignores standing flood water.',
        },
        provenance,
      }

      results.push({ ok: true, route })
    }

    return Effect.succeed({
      results,
      costing: query.costing,
      engineNotes:
        'Costing mode applied. Real-time road damage or submerged roads are not reflected in baseline map data.',
    })
  }
}
