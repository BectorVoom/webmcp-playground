import { Effect } from 'effect'
import type { AlertCertainty, AlertSeverity, AlertUrgency, OfficialAlert } from '../../../domain/alerts'
import type { BBox, LonLat } from '../../../domain/geo'
import type { Coverage, Provenance } from '../../../domain/provenance'
import { metresBetween } from '../../../lib/geometry/directions'
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
  /**
   * The extent the alert was issued for, as [minLon, minLat, maxLon, maxLat]. Required: an alert
   * with no extent cannot be shown to apply anywhere, and the JMA/NWS/MeteoAlarm feeds these
   * fixtures stand in for are all area-scoped.
   */
  readonly area: ReadonlyArray<number>
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

const asBBox = (raw: ReadonlyArray<number>): BBox | null => {
  const [minLon, minLat, maxLon, maxLat] = raw
  if (raw.length !== 4) return null
  if (
    minLon === undefined ||
    minLat === undefined ||
    maxLon === undefined ||
    maxLat === undefined ||
    !Number.isFinite(minLon) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLon) ||
    !Number.isFinite(maxLat)
  ) {
    return null
  }
  return [minLon, minLat, maxLon, maxLat]
}

/** Kilometres from a point to the nearest edge of a box, 0 when the point is inside it. */
const kmToBBox = (at: LonLat, [minLon, minLat, maxLon, maxLat]: BBox): number => {
  const nearest: LonLat = {
    longitude: Math.min(Math.max(at.longitude, minLon), maxLon),
    latitude: Math.min(Math.max(at.latitude, minLat), maxLat),
  }
  return metresBetween(at, nearest) / 1000
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
    /** Alerts the feed carries for somewhere else. Their existence is why an empty result here
     * means "we hold nothing for your area", not "nothing is in force". */
    const outOfAreaDescriptions = new Set<string>()
    /** Alerts we could not place. Kept rather than dropped: never hide a warning (R2.8). */
    let unplaceableCount = 0

    for (const a of rawData.alerts || []) {
      const area = asBBox(a.area)
      if (area === null) {
        unplaceableCount++
      } else if (kmToBBox(query.at, area) > query.radiusKm) {
        outOfAreaDescriptions.add(a.areaDescription)
        continue
      }

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

    const limit = query.limit ?? 10
    const cappedAlerts = activeAlerts.slice(0, limit)

    return Effect.succeed({
      alerts: cappedAlerts,
      totalActiveCount: activeAlerts.length,
      expiredCount,
      coverage: this.describeCoverage({
        matched: activeAlerts.length,
        capped: activeAlerts.length - cappedAlerts.length,
        unplaceableCount,
        outOfAreaDescriptions,
      }),
      staleness: { stale: false },
    })
  }

  /**
   * Why this result is or is not the whole truth (R2.8).
   *
   * The distinction that matters is between "the feed covers you and reports nothing" and "the
   * feed does not cover you at all". Both return zero alerts, but only the first one means the
   * user is not under a warning, and a reader told the wrong one acts on it.
   */
  private describeCoverage(counts: {
    readonly matched: number
    readonly capped: number
    readonly unplaceableCount: number
    readonly outOfAreaDescriptions: ReadonlySet<string>
  }): Coverage {
    const { matched, capped, unplaceableCount, outOfAreaDescriptions } = counts

    if (matched === 0 && outOfAreaDescriptions.size > 0) {
      return {
        state: 'none',
        reason: 'no_data_for_area',
        detail: `This ${this.region.toUpperCase()} fixture feed only carries alerts for ${[...outOfAreaDescriptions].join(', ')}, which does not reach the queried location.`,
        failedSources: [],
      }
    }

    if (capped > 0) {
      return {
        state: 'partial',
        reason: 'result_cap',
        detail: `${capped} of ${matched} alerts in force were omitted to fit the result cap.`,
        failedSources: [],
      }
    }

    if (unplaceableCount > 0) {
      return {
        state: 'partial',
        detail: `${unplaceableCount} alert(s) declare no usable area and were included regardless — treat their applicability to this location as unverified.`,
        failedSources: [],
      }
    }

    return { state: 'full', failedSources: [] }
  }
}
