import { Effect } from 'effect'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureAlertsProvider } from '../fixture/fixture-alerts'

export class UsAlertsProvider implements AlertsPort {
  readonly sourceId = 'us.nws.alerts'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'NWS Active Weather & Flood Alerts',
    docsUrl: 'https://www.weather.gov/documentation/services-web-api',
    licence: 'U.S. Public Domain',
    attribution: 'National Oceanic and Atmospheric Administration / National Weather Service',
    expectedRefreshMs: 60_000,
  }

  private readonly fixture = new FixtureAlertsProvider('us')

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
