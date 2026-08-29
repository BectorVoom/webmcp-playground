import { Effect } from 'effect'
import type { FloodDataPort, FloodQuery, FloodQueryResult, ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureFloodProvider } from '../fixture/fixture-flood'

export class JpFloodProvider implements FloodDataPort {
  readonly sourceId = 'jp.gsi.flood-l2'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: '国土地理院 浸水想定区域（想定最大規模）',
    docsUrl: 'https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html',
    vintage: '2025-03',
    licence: 'GSI Content Terms of Use',
    attribution: '国土地理院 国土数値情報（浸水想定区域データ）',
    expectedRefreshMs: 86_400_000 * 365,
  }

  private readonly fixtureFallback = new FixtureFloodProvider('jp')

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return this.fixtureFallback.zonesWithin(query).pipe(
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
