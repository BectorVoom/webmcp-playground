import { Effect } from 'effect'
import type { OfficialAlert } from '../../../domain/alerts'
import type { LonLat } from '../../../domain/geo'
import type { Provenance } from '../../../domain/provenance'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureAlertsProvider } from '../fixture/fixture-alerts'
import { fetchViaProxy, parseUpstreamJson } from '../proxy-client'
import { capCertainty, capEpoch, capSeverity, capUrgency, isActualAlert, SEVERITY_ORDER } from '../cap'

/** api.weather.gov returns CAP fields inside a GeoJSON FeatureCollection. */
interface NwsAlertProperties {
  readonly id?: string
  readonly areaDesc?: string
  readonly sent?: string
  readonly effective?: string
  readonly onset?: string
  readonly expires?: string
  readonly ends?: string | null
  readonly status?: string
  readonly messageType?: string
  readonly severity?: string
  readonly certainty?: string
  readonly urgency?: string
  readonly event?: string
  readonly senderName?: string
  readonly headline?: string | null
  readonly description?: string | null
  readonly instruction?: string | null
}
export interface NwsAlertsPayload {
  readonly features?: ReadonlyArray<{ readonly properties?: NwsAlertProperties }>
}

export const NWS_ALERTS_URL = (at: LonLat): string =>
  `https://api.weather.gov/alerts/active?point=${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`

/**
 * Active NWS alerts, from NWS's own feed, for anywhere in the United States.
 *
 * `alerts/active?point=` does the spatial work upstream: NWS resolves the point to its forecast
 * zones and returns only what is in force there, so this needs no zone table of its own and covers
 * the lower 48, Alaska, Hawaii and the territories identically.
 *
 * Like its JP counterpart, a failure here is reported as a failure. Falling back to the recorded
 * Washington DC fixture would put a Potomac flood warning in front of someone in Houston.
 */
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
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  alertsFor(query: AlertsQuery): Effect.Effect<AlertsQueryResult, GeoError> {
    return fetchViaProxy(this.fetchImpl, {
      kind: 'alerts',
      at: query.at,
      sourceId: this.sourceId,
      upstreamUrl: NWS_ALERTS_URL(query.at),
      radiusKm: query.radiusKm,
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) return this.fixture.alertsFor(query)

        return parseUpstreamJson<NwsAlertsPayload>(this.sourceId, response.text).pipe(
          Effect.map((payload) =>
            this.toResult(payload, query, {
              cacheHit: response.cacheHit,
              cacheAgeMs: response.cacheAgeMs,
            }),
          ),
        )
      }),
    )
  }

  private toResult(
    payload: NwsAlertsPayload,
    query: AlertsQuery,
    cache: { readonly cacheHit: boolean; readonly cacheAgeMs: number },
  ): AlertsQueryResult {
    const now = Date.now()
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: NWS_ALERTS_URL(query.at),
      retrievedAt: now,
      cache: { hit: cache.cacheHit, ageMs: cache.cacheAgeMs },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    const alerts: Array<OfficialAlert> = []
    let expiredCount = 0
    let nonActualCount = 0

    for (const feature of payload.features ?? []) {
      const p = feature.properties
      if (!p?.id) continue

      // NWS publishes drills and system tests down the same pipe as real warnings, and a test
      // alert rendered as real is the worst output this tool can produce.
      if (!isActualAlert(p.status, p.messageType)) {
        nonActualCount++
        continue
      }

      const expires = capEpoch(p.expires) ?? capEpoch(p.ends)
      if (expires !== null && expires < now) {
        expiredCount++
        continue
      }

      alerts.push({
        id: p.id,
        event: p.event ?? 'Alert',
        severity: capSeverity(p.severity),
        urgency: capUrgency(p.urgency),
        certainty: capCertainty(p.certainty),
        headline: p.headline ?? p.event ?? 'Alert',
        description: p.description ?? '',
        instruction: p.instruction ?? null,
        onset: capEpoch(p.onset),
        effective: capEpoch(p.effective) ?? capEpoch(p.sent) ?? now,
        expires,
        sender: p.senderName ?? 'National Weather Service',
        areaDescription: p.areaDesc ?? 'United States',
        language: 'en',
        provenance,
      })
    }

    alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

    const limit = query.limit ?? 10
    const capped = alerts.slice(0, limit)

    return {
      alerts: capped,
      totalActiveCount: alerts.length,
      expiredCount,
      coverage:
        capped.length < alerts.length
          ? {
              state: 'partial',
              reason: 'result_cap',
              detail: `${alerts.length - capped.length} of ${alerts.length} alerts in force were omitted to fit the result cap.`,
              failedSources: [],
            }
          : nonActualCount > 0
            ? {
                state: 'full',
                detail: `${nonActualCount} non-actual (test or exercise) message(s) were excluded.`,
                failedSources: [],
              }
            : { state: 'full', failedSources: [] },
      staleness: { stale: false },
    }
  }
}
