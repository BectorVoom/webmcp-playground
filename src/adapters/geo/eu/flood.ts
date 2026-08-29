import { Effect } from 'effect'
import type { FloodDataPort, FloodQuery, FloodQueryResult, ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureFloodProvider } from '../fixture/fixture-flood'

export class EuFloodForecastProvider implements FloodDataPort {
  readonly sourceId = 'eu.copernicus.efas'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Copernicus Emergency Management Service (EFAS)',
    docsUrl: 'https://www.efas.eu/',
    vintage: '2026-04',
    licence: 'Copernicus Open Access Licence',
    attribution: 'European Commission Copernicus Emergency Management Service (EFAS river flood forecast — coarse resolution)',
    expectedRefreshMs: 43200_000, // 12 hours
  }

  private readonly fixture = new FixtureFloodProvider('eu')

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return this.fixture.zonesWithin(query).pipe(
      Effect.map((res) => ({
        ...res,
        zones: res.zones.map((z) => ({
          ...z,
          provenance: {
            ...z.provenance,
            sourceId: this.meta.sourceId,
            sourceName: this.meta.sourceName,
            attribution: this.meta.attribution,
            licence: this.meta.licence,
          },
        })),
      })),
    )
  }
}
