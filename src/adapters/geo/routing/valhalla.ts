import { Effect } from 'effect'
import type { GeoError } from '../../../domain/geo-errors'
import type { ExclusionState } from '../../../domain/routing'
import type { RouteQuery, RoutingPort, RoutingQueryResult } from '../../../ports/Routing'
import type { ProviderMeta } from '../../../ports/FloodData'
import { FixtureRoutingProvider } from '../fixture/fixture-routing'

export class ValhallaRoutingProvider implements RoutingPort {
  readonly sourceId = 'global.valhalla.routing'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Valhalla Routing Engine',
    docsUrl: 'https://valhalla.github.io/valhalla/',
    vintage: '2026-04',
    licence: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors, Valhalla routing engine',
    expectedRefreshMs: 86_400_000,
  }

  private readonly fixture = new FixtureRoutingProvider()

  route(query: RouteQuery): Effect.Effect<RoutingQueryResult, GeoError> {
    return this.fixture.route(query).pipe(
      Effect.map((res) => {
        const exclusionsState: ExclusionState =
          query.exclusions && query.exclusions.length > 0 ? 'applied' : 'not_requested'

        return {
          ...res,
          results: res.results.map((r) => {
            if (r.ok) {
              return {
                ok: true,
                route: {
                  ...r.route,
                  exclusions: exclusionsState,
                  provenance: {
                    ...r.route.provenance,
                    sourceId: this.meta.sourceId,
                    sourceName: this.meta.sourceName,
                    attribution: this.meta.attribution,
                    licence: this.meta.licence,
                  },
                },
              }
            }
            return r
          }),
        }
      }),
    )
  }
}
