import { Effect } from 'effect'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureAlertsProvider } from '../fixture/fixture-alerts'

export class EuAlertsProvider implements AlertsPort {
  readonly sourceId = 'eu.meteoalarm.alerts'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'EUMETNET MeteoAlarm',
    docsUrl: 'https://meteoalarm.org/',
    licence: 'MeteoAlarm Terms of Use',
    attribution: 'EUMETNET MeteoAlarm / National Meteorological Services',
    expectedRefreshMs: 60_000,
  }

  private readonly fixture = new FixtureAlertsProvider('eu')

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
