import { Effect } from 'effect'
import type { AlertCertainty, AlertSeverity, AlertUrgency, OfficialAlert } from '../../../domain/alerts'
import type { Provenance } from '../../../domain/provenance'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import jpAlerts from '../../../../fixtures/geo/jp/alerts/normal.json'
import usAlerts from '../../../../fixtures/geo/us/alerts/normal.json'
import euAlerts from '../../../../fixtures/geo/eu/alerts/normal.json'
import type { RegionId } from '../region'

interface FixtureAlertItem {
  readonly id: string
  readonly event: string
  readonly severity: string
  readonly urgency: string
  readonly certainty: string
  readonly headline: string
  readonly description: string
  readonly instruction?: string | null
  readonly onset?: number | null
  readonly effective: number
  readonly expires?: number | null
  readonly sender: string
  readonly areaDescription: string
  readonly language: string
  readonly officialTranslation?: {
    readonly language: string
    readonly headline: string
    readonly description: string
    readonly instruction?: string | null
  }
}

interface FixtureAlertsFile {
  readonly capturedAt: number
  readonly upstreamUrl: string
  readonly sourceId: string
  readonly licence: string
  readonly attribution: string
  readonly alerts?: ReadonlyArray<FixtureAlertItem>
}

export class FixtureAlertsProvider implements AlertsPort {
  readonly sourceId: string
  readonly meta: ProviderMeta
  private readonly region: RegionId

  constructor(region: RegionId = 'jp') {
    this.region = region
    this.sourceId = `${region}.fixture.alerts`
    this.meta = {
      sourceId: this.sourceId,
      sourceName: `Simulated ${region.toUpperCase()} Alerts Provider`,
      docsUrl: 'https://example.com/docs/fixture-alerts',
      vintage: '2026-04-fixture',
      licence: 'Fixture Test Data',
      attribution: `Simulated ${region.toUpperCase()} Official Warning Feed (Fixture Mode)`,
      expectedRefreshMs: 60_000,
    }
  }

  alertsFor(query: AlertsQuery): Effect.Effect<AlertsQueryResult, never> {
    const rawData: FixtureAlertsFile =
      this.region === 'jp' ? jpAlerts : this.region === 'us' ? usAlerts : euAlerts

    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: rawData.upstreamUrl,
      issuedAt: rawData.capturedAt,
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'fixture',
    }

    const now = Date.now()
    const activeAlerts: Array<OfficialAlert> = []
    let expiredCount = 0

    for (const a of rawData.alerts || []) {
      if (a.expires && a.expires < now) {
        expiredCount++
        continue
      }
      activeAlerts.push({
        id: a.id,
        event: a.event,
        severity: a.severity as AlertSeverity,
        urgency: a.urgency as AlertUrgency,
        certainty: a.certainty as AlertCertainty,
        headline: a.headline,
        description: a.description,
        instruction: a.instruction ?? null,
        onset: a.onset ?? null,
        effective: a.effective,
        expires: a.expires ?? null,
        sender: a.sender,
        areaDescription: a.areaDescription,
        language: a.language,
        officialTranslation: a.officialTranslation
          ? {
              ...a.officialTranslation,
              instruction: a.officialTranslation.instruction ?? null,
            }
          : undefined,
        provenance,
      })
    }

    const cappedAlerts = activeAlerts.slice(0, query.limit ?? 10)

    return Effect.succeed({
      alerts: cappedAlerts,
      totalActiveCount: activeAlerts.length,
      expiredCount,
      coverage: {
        state: activeAlerts.length > 0 ? 'full' : 'none',
        failedSources: [],
      },
      staleness: { stale: false },
    })
  }
}
