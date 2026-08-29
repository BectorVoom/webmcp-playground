import { Effect } from 'effect'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureAlertsProvider } from '../fixture/fixture-alerts'

export class JpAlertsProvider implements AlertsPort {
  readonly sourceId = 'jp.jma.warnings'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: '気象庁 防災気象情報（警報・注意報）',
    docsUrl: 'https://www.jma.go.jp/jma/kishou/info/coment.html',
    licence: 'JMA Terms of Use',
    attribution: '気象庁 防災気象情報',
    expectedRefreshMs: 60_000,
  }

  private readonly fixture = new FixtureAlertsProvider('jp')

  alertsFor(query: AlertsQuery): Effect.Effect<AlertsQueryResult, GeoError> {
    return this.fixture.alertsFor(query).pipe(
      Effect.map((res) => ({
        ...res,
        alerts: res.alerts.map((a) => ({
          ...a,
          provenance: {
            ...a.provenance,
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
