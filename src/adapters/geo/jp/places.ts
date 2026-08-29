import { Effect } from 'effect'
import type { PlacesPort, PlacesQuery, PlacesQueryResult } from '../../../ports/Places'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixturePlacesProvider } from '../fixture/fixture-places'

export class JpPlacesProvider implements PlacesPort {
  readonly sourceId = 'jp.gsi.shelters'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: '国土地理院 指定緊急避難場所',
    docsUrl: 'https://www.gsi.go.jp/kikakukouhou/kikakukouhou40182.html',
    vintage: '2025-03',
    licence: 'GSI Content Terms of Use',
    attribution: '指定緊急避難場所データ: 国土地理院',
    expectedRefreshMs: 86_400_000 * 30,
  }

  private readonly fixture = new FixturePlacesProvider('jp')

  facilitiesWithin(query: PlacesQuery): Effect.Effect<PlacesQueryResult, GeoError> {
    return this.fixture.facilitiesWithin(query).pipe(
      Effect.map((res) => ({
        ...res,
        facilities: res.facilities.map((f) => ({
          ...f,
          provenance: {
            ...f.provenance,
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
