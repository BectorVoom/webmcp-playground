import { Effect } from 'effect'
import type { OfficialAlert } from '../../../domain/alerts'

import type { Coverage, Provenance } from '../../../domain/provenance'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import { SourceUnavailable, type GeoError } from '../../../domain/geo-errors'
import { isPointInGeometry } from '../../../lib/geometry/measure'
import { FixtureAlertsProvider } from '../fixture/fixture-alerts'
import { fetchViaProxy } from '../proxy-client'
import { capCertainty, capEpoch, capSeverity, capUrgency, isActualAlert, SEVERITY_ORDER } from '../cap'
import {
  METEOALARM_FEED_URL,
  resolveMeteoAlarmCountry,
  type MeteoAlarmCountry,
} from './meteoalarm-countries'

const CAP_NS = 'urn:oasis:names:tc:emergency:cap:1.2'
const ATOM_NS = 'http://www.w3.org/2005/Atom'

/** One parsed `<entry>`, before it becomes an OfficialAlert. */
interface AtomEntry {
  readonly identifier: string
  readonly event: string
  readonly areaDesc: string
  readonly title: string
  readonly severity: string | null
  readonly urgency: string | null
  readonly certainty: string | null
  readonly status: string | null
  readonly messageType: string | null
  readonly sent: string | null
  readonly effective: string | null
  readonly onset: string | null
  readonly expires: string | null
  /** CAP polygons, already converted to GeoJSON ring order. Usually empty. */
  readonly polygons: ReadonlyArray<GeoJSON.Polygon>
}

const capText = (entry: Element, tag: string): string | null =>
  entry.getElementsByTagNameNS(CAP_NS, tag).item(0)?.textContent?.trim() ?? null

/**
 * CAP writes a polygon as space-separated `lat,lon` pairs — latitude first, the opposite of
 * GeoJSON. Getting this backwards puts every European warning in the Indian Ocean, where it
 * silently matches nothing, so the swap happens exactly here and nowhere else.
 */
const parseCapPolygon = (raw: string): GeoJSON.Polygon | null => {
  const ring: Array<[number, number]> = []
  for (const pair of raw.trim().split(/\s+/)) {
    const [latRaw, lonRaw] = pair.split(',')
    const latitude = Number(latRaw)
    const longitude = Number(lonRaw)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    ring.push([longitude, latitude])
  }
  if (ring.length < 4) return null
  const first = ring[0]!
  const last = ring[ring.length - 1]!
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
  return { type: 'Polygon', coordinates: [ring] }
}

export const parseMeteoAlarmFeed = (xml: string): ReadonlyArray<AtomEntry> => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return []

  const entries: Array<AtomEntry> = []
  const nodes = doc.getElementsByTagNameNS(ATOM_NS, 'entry')

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    if (!node) continue

    const polygons: Array<GeoJSON.Polygon> = []
    const polygonNodes = node.getElementsByTagNameNS(CAP_NS, 'polygon')
    for (let p = 0; p < polygonNodes.length; p++) {
      const raw = polygonNodes.item(p)?.textContent
      const polygon = raw ? parseCapPolygon(raw) : null
      if (polygon) polygons.push(polygon)
    }

    const title =
      node.getElementsByTagNameNS(ATOM_NS, 'title').item(0)?.textContent?.trim() ?? ''
    const identifier =
      capText(node, 'identifier') ??
      node.getElementsByTagNameNS(ATOM_NS, 'id').item(0)?.textContent?.trim() ??
      `meteoalarm-${i}`

    entries.push({
      identifier,
      event: capText(node, 'event') ?? title,
      areaDesc: capText(node, 'areaDesc') ?? '',
      title,
      severity: capText(node, 'severity'),
      urgency: capText(node, 'urgency'),
      certainty: capText(node, 'certainty'),
      status: capText(node, 'status'),
      messageType: capText(node, 'message_type'),
      sent: capText(node, 'sent'),
      effective: capText(node, 'effective'),
      onset: capText(node, 'onset'),
      expires: capText(node, 'expires'),
      polygons,
    })
  }
  return entries
}

/**
 * Warnings in force from MeteoAlarm, for anywhere in Europe.
 *
 * MeteoAlarm has no point query. It publishes one feed per country, and most entries identify
 * their area only by a NUTS3 region code — no geometry — so this cannot always narrow a country's
 * warnings down to the ones covering the caller. What it does instead:
 *
 * - entries that *do* carry a `cap:polygon` are point-tested and dropped when they do not contain
 *   the location, which is the precise filtering the geometry allows;
 * - entries with no geometry are kept, never silently dropped, and each carries its own region in
 *   `areaDescription` so a reader can see it is for somewhere else in the country;
 * - coverage says so explicitly, so "3 warnings" is never mistaken for "3 warnings where you are".
 *
 * Keeping the unplaceable ones is the deliberate half. Hiding a real warning because its feed
 * omitted a polygon is the failure that matters here.
 */
export class EuAlertsProvider implements AlertsPort {
  readonly sourceId = 'eu.meteoalarm.alerts'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'EUMETNET MeteoAlarm',
    docsUrl: 'https://meteoalarm.org/',
    licence: 'CC BY 4.0 (MeteoAlarm Terms and Conditions)',
    attribution: 'EUMETNET MeteoAlarm / National Meteorological Services',
    expectedRefreshMs: 60_000,
  }

  private readonly fixture = new FixtureAlertsProvider('eu')
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  alertsFor(query: AlertsQuery): Effect.Effect<AlertsQueryResult, GeoError> {
    const country = resolveMeteoAlarmCountry(query.at)

    return fetchViaProxy(this.fetchImpl, {
      kind: 'alerts',
      at: query.at,
      sourceId: this.sourceId,
      upstreamUrl: METEOALARM_FEED_URL(country.slug),
      radiusKm: query.radiusKm,
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) return this.fixture.alertsFor(query)

        const entries = parseMeteoAlarmFeed(response.text)
        // An empty feed is normal; an unparseable one is not, and must not read as "all clear".
        if (entries.length === 0 && !response.text.includes('</feed>')) {
          return Effect.fail(
            new SourceUnavailable({
              sourceId: this.sourceId,
              message: `MeteoAlarm returned a body that is not an Atom feed: ${response.text.slice(0, 200)}`,
            }),
          )
        }

        return Effect.succeed(
          this.toResult(entries, country, query, {
            cacheHit: response.cacheHit,
            cacheAgeMs: response.cacheAgeMs,
          }),
        )
      }),
    )
  }

  private toResult(
    entries: ReadonlyArray<AtomEntry>,
    country: MeteoAlarmCountry,
    query: AlertsQuery,
    cache: { readonly cacheHit: boolean; readonly cacheAgeMs: number },
  ): AlertsQueryResult {
    const now = Date.now()
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: METEOALARM_FEED_URL(country.slug),
      retrievedAt: now,
      cache: { hit: cache.cacheHit, ageMs: cache.cacheAgeMs },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    const placed: Array<OfficialAlert> = []
    const unplaced: Array<OfficialAlert> = []
    let expiredCount = 0
    let excludedByGeometry = 0

    for (const entry of entries) {
      if (!isActualAlert(entry.status, entry.messageType)) continue

      const expires = capEpoch(entry.expires)
      if (expires !== null && expires < now) {
        expiredCount++
        continue
      }

      const hasGeometry = entry.polygons.length > 0
      if (hasGeometry && !entry.polygons.some((p) => isPointInGeometry(query.at, p))) {
        excludedByGeometry++
        continue
      }

      const areaDescription = entry.areaDesc
        ? `${country.name} — ${entry.areaDesc}`
        : country.name

      const alert: OfficialAlert = {
        id: entry.identifier,
        event: entry.event,
        severity: capSeverity(entry.severity),
        urgency: capUrgency(entry.urgency),
        certainty: capCertainty(entry.certainty),
        // MeteoAlarm's own wording. The legacy feed carries no description or instruction text,
        // and none is invented here (R4.6, ADR-5).
        headline: entry.title,
        description: entry.title,
        instruction: null,
        onset: capEpoch(entry.onset),
        effective: capEpoch(entry.effective) ?? capEpoch(entry.sent) ?? now,
        expires,
        sender: 'EUMETNET MeteoAlarm',
        areaDescription,
        language: 'en',
        provenance,
      }

      if (hasGeometry) placed.push(alert)
      else unplaced.push(alert)
    }

    const bySeverity = (a: OfficialAlert, b: OfficialAlert): number =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    placed.sort(bySeverity)
    unplaced.sort(bySeverity)

    // Confirmed-at-your-location first; the rest of the country behind them.
    const alerts = [...placed, ...unplaced]
    const limit = query.limit ?? 10
    const capped = alerts.slice(0, limit)

    return {
      alerts: capped,
      totalActiveCount: alerts.length,
      expiredCount,
      coverage: this.describeCoverage({
        country,
        total: alerts.length,
        capped: alerts.length - capped.length,
        unplacedInResult: capped.filter((a) => unplaced.includes(a)).length,
        excludedByGeometry,
      }),
      staleness: { stale: false },
    }
  }

  private describeCoverage(counts: {
    readonly country: MeteoAlarmCountry
    readonly total: number
    readonly capped: number
    readonly unplacedInResult: number
    readonly excludedByGeometry: number
  }): Coverage {
    const { country, total, capped, unplacedInResult, excludedByGeometry } = counts

    if (capped > 0) {
      return {
        state: 'partial',
        reason: 'result_cap',
        detail: `${capped} of ${total} warnings in force in ${country.name} were omitted to fit the result cap.`,
        failedSources: [],
      }
    }

    if (unplacedInResult > 0) {
      return {
        state: 'partial',
        detail:
          `${unplacedInResult} of these warnings identify their area only by region name, not by geometry, ` +
          `so they are everything in force across ${country.name} rather than only what covers this location — ` +
          `check each warning's area before acting on it.` +
          (excludedByGeometry > 0
            ? ` A further ${excludedByGeometry} warning(s) did publish geometry and were confirmed not to cover this location.`
            : ''),
        failedSources: [],
      }
    }

    return { state: 'full', failedSources: [] }
  }
}
