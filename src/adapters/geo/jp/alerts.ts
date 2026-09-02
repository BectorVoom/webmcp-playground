import { Effect } from 'effect'
import type {
  AlertCertainty,
  AlertSeverity,
  AlertUrgency,
  OfficialAlert,
} from '../../../domain/alerts'
import type { Provenance } from '../../../domain/provenance'
import type { AlertsPort, AlertsQuery, AlertsQueryResult } from '../../../ports/Alerts'
import type { ProviderMeta } from '../../../ports/FloodData'
import type { GeoError } from '../../../domain/geo-errors'
import { FixtureAlertsProvider } from '../fixture/fixture-alerts'
import { fetchViaProxy, parseUpstreamJson } from '../proxy-client'
import { JMA_CLASS10_NAMES } from './jma-area-names'
import { resolveJmaOffice, type JmaOffice } from './jma-areas'

/**
 * The shape JMA actually publishes at `/bosai/warning/data/r8/{office}.json`.
 *
 * One file holds several bulletins — 警報・注意報 (VPWW55), 土砂災害警戒情報 (VPWW56), and others —
 * each with its own `reportDatetime` and its own prose. A warning code appears inside whichever
 * bulletin issued it, so the headline that belongs to an alert is its bulletin's, not the file's.
 */
interface JmaKind {
  readonly code?: string
  readonly status?: string
}
interface JmaAreaItem {
  readonly areaCode?: string
  readonly kinds?: ReadonlyArray<JmaKind>
}
export interface JmaBulletin {
  readonly reportDatetime?: string
  readonly publishingOffice?: string
  readonly headlineText?: string
  readonly dataTypeCode?: string
  readonly warning?: {
    readonly class10Items?: ReadonlyArray<JmaAreaItem>
  }
}

interface WarningKind {
  readonly name: string
  readonly severity: AlertSeverity
  readonly urgency: AlertUrgency
  readonly certainty: AlertCertainty
}

const extreme = (name: string): WarningKind => ({
  name,
  severity: 'extreme',
  urgency: 'immediate',
  certainty: 'observed',
})
const warning = (name: string): WarningKind => ({
  name,
  severity: 'severe',
  urgency: 'immediate',
  certainty: 'likely',
})
const advisory = (name: string): WarningKind => ({
  name,
  severity: 'moderate',
  urgency: 'expected',
  certainty: 'possible',
})

/**
 * JMA's warning codes and the names it publishes for them.
 *
 * The feed carries only a two-digit code, so this table is what makes "03" readable as 大雨警報.
 * The three tiers are JMA's own and map cleanly onto CAP severity: 特別警報 is issued for events
 * expected once in decades, 警報 for danger to life, 注意報 for conditions worth watching.
 */
const WARNING_KINDS: Readonly<Record<string, WarningKind>> = {
  // 特別警報 — extraordinary
  '32': extreme('暴風雪特別警報'),
  '33': extreme('大雨特別警報'),
  '35': extreme('暴風特別警報'),
  '36': extreme('大雪特別警報'),
  '37': extreme('波浪特別警報'),
  '38': extreme('高潮特別警報'),
  // 警報 — warnings
  '02': warning('暴風雪警報'),
  '03': warning('大雨警報'),
  '04': warning('洪水警報'),
  '05': warning('暴風警報'),
  '06': warning('大雪警報'),
  '07': warning('波浪警報'),
  '08': warning('高潮警報'),
  // 注意報 — advisories
  '10': advisory('大雨注意報'),
  '12': advisory('大雪注意報'),
  '13': advisory('風雪注意報'),
  '14': advisory('雷注意報'),
  '15': advisory('強風注意報'),
  '16': advisory('波浪注意報'),
  '17': advisory('融雪注意報'),
  '18': advisory('洪水注意報'),
  '19': advisory('高潮注意報'),
  '20': advisory('濃霧注意報'),
  '21': advisory('乾燥注意報'),
  '22': advisory('なだれ注意報'),
  '23': advisory('低温注意報'),
  '24': advisory('霜注意報'),
  '25': advisory('着氷注意報'),
  '26': advisory('着雪注意報'),
  // Issued jointly by JMA and the prefecture when landslide risk reaches the evacuation threshold.
  '49': warning('土砂災害警戒情報'),
}

/**
 * A code this build does not have a name for.
 *
 * JMA adds and renumbers codes — 09, 29, 43 and 48 are all live in the national feed today and are
 * not in any published table this was built from. Dropping them would hide a real warning, and
 * inventing a name for them would put words in JMA's mouth, so the code travels through as-is with
 * the bulletin's own prose attached. Severity is 'unknown' because it is; the sort below is what
 * stops that being read as "mild".
 */
const unknownKind = (code: string): WarningKind => ({
  name: `気象警報・注意報（コード${code}）`,
  severity: 'unknown',
  urgency: 'unknown',
  certainty: 'unknown',
})

/**
 * An unrecognised official warning is not evidence of a mild one, so it sorts above everything
 * that is definitely an advisory. Only the two tiers JMA calls warnings outrank it.
 */
const JP_SORT_RANK: Readonly<Record<AlertSeverity, number>> = {
  extreme: 0,
  severe: 1,
  unknown: 2,
  moderate: 3,
  minor: 4,
}

/**
 * How old the newest bulletin may be before the feed is treated as suspect rather than quiet.
 *
 * This exists because of a real failure: the previous endpoint, `/bosai/warning/data/warning/`,
 * was frozen at 26 May 2026 while JMA moved to `r8`. It kept answering 200 with well-formed JSON,
 * so every location in Japan read as "nothing in force" — including Fukui on the morning it was
 * under a level 5 大雨特別警報. A feed advertising a one-minute refresh that has not been
 * republished in a month is far more likely dead than calm, and must say so.
 */
const FEED_SUSPECT_AFTER_MS = 30 * 86_400_000


/**
 * Whether an entry is in force.
 *
 * Kept deliberately permissive. A status we have never seen before is treated as in force, because
 * the cost of inventing a lifted warning is a scare and the cost of hiding a live one is not.
 */
const isInForce = (status: string | undefined): boolean => {
  if (!status) return false
  if (status.includes('解除')) return false
  if (status.includes('発表警報・注意報はなし')) return false
  return true
}

const areaName = (code: string | undefined): string =>
  (code ? JMA_CLASS10_NAMES[code] : undefined) ?? code ?? '不明な区域'

/**
 * The `r8` path is JMA's current warning feed. The older `data/warning/{code}.json` still answers
 * 200 with valid-looking JSON but has not been republished since May 2026 — see
 * FEED_SUSPECT_AFTER_MS for why that mattered.
 */
export const JMA_WARNING_URL = (officeCode: string): string =>
  `https://www.jma.go.jp/bosai/warning/data/r8/${officeCode}.json`

/**
 * Warnings and advisories in force, from JMA's own feed, for anywhere in Japan.
 *
 * JMA publishes per warning office rather than per prefecture, so `resolveJmaOffice` picks the
 * feed and its name travels into every alert's `areaDescription` — a reader near a prefecture
 * border can see which authority's warnings they are being shown.
 *
 * On failure this reports the failure. It deliberately does not fall back to the recorded
 * fixtures: those carry Tokyo's warnings, and answering a Fukui query with them is the exact
 * failure this provider exists to end.
 */
export class JpAlertsProvider implements AlertsPort {
  readonly sourceId = 'jp.jma.warnings'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: '気象庁 防災気象情報（警報・注意報）',
    docsUrl: 'https://www.jma.go.jp/bosai/map.html',
    licence: 'JMA Terms of Use',
    attribution: '気象庁 防災気象情報',
    expectedRefreshMs: 60_000,
  }

  private readonly fixture = new FixtureAlertsProvider('jp')
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    // Wrapped, not captured: `fetch` pulled off the global and called as a method throws
    // "Illegal invocation" in a browser.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  alertsFor(query: AlertsQuery): Effect.Effect<AlertsQueryResult, GeoError> {
    const office = resolveJmaOffice(query.at)

    return fetchViaProxy(this.fetchImpl, {
      kind: 'alerts',
      at: query.at,
      sourceId: this.sourceId,
      upstreamUrl: JMA_WARNING_URL(office.code),
      radiusKm: query.radiusKm,
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        // The server is in fixture mode. Use the recorded feed, which filters by area itself.
        if (response.servedFromFixture) return this.fixture.alertsFor(query)

        return parseUpstreamJson<ReadonlyArray<JmaBulletin>>(this.sourceId, response.text).pipe(
          Effect.map((payload) =>
            this.toResult(payload, office, query, {
              cacheHit: response.cacheHit,
              cacheAgeMs: response.cacheAgeMs,
            }),
          ),
        )
      }),
    )
  }

  private toResult(
    payload: ReadonlyArray<JmaBulletin>,
    office: JmaOffice,
    query: AlertsQuery,
    cache: { readonly cacheHit: boolean; readonly cacheAgeMs: number },
  ): AlertsQueryResult {
    const bulletins = Array.isArray(payload) ? payload : []
    const reportTimes = bulletins
      .map((b) => (b.reportDatetime ? Date.parse(b.reportDatetime) : Number.NaN))
      .filter((t) => Number.isFinite(t))
    const newestReport = reportTimes.length > 0 ? Math.max(...reportTimes) : undefined

    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: JMA_WARNING_URL(office.code),
      issuedAt: newestReport,
      retrievedAt: Date.now(),
      cache: { hit: cache.cacheHit, ageMs: cache.cacheAgeMs },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    /** Each warning code, the areas it covers, and the bulletin whose prose describes it. */
    const found = new Map<
      string,
      { areas: Array<string>; headline: string; reportDatetime: number | undefined }
    >()

    for (const bulletin of bulletins) {
      const issuedAt = bulletin.reportDatetime ? Date.parse(bulletin.reportDatetime) : Number.NaN
      for (const item of bulletin.warning?.class10Items ?? []) {
        for (const kind of item.kinds ?? []) {
          if (!kind.code || !isInForce(kind.status)) continue
          const entry = found.get(kind.code) ?? {
            areas: [] as Array<string>,
            headline: bulletin.headlineText ?? '',
            reportDatetime: Number.isFinite(issuedAt) ? issuedAt : undefined,
          }
          const name = areaName(item.areaCode)
          if (!entry.areas.includes(name)) entry.areas.push(name)
          found.set(kind.code, entry)
        }
      }
    }

    const alerts: Array<OfficialAlert> = []
    for (const [code, entry] of found) {
      const kind = WARNING_KINDS[code] ?? unknownKind(code)
      const areaDescription = `${office.name}（${entry.areas.join('、')}）`
      const effective = entry.reportDatetime ?? newestReport ?? Date.now()
      alerts.push({
        id: `jma-${office.code}-${code}`,
        event: kind.name,
        severity: kind.severity,
        urgency: kind.urgency,
        certainty: kind.certainty,
        headline: `${areaDescription} ${kind.name}`,
        // The issuing bulletin's own prose, verbatim. No translation, no summary (R4.6, ADR-5).
        description:
          entry.headline.length > 0
            ? entry.headline
            : `${areaDescription}に${kind.name}が発表されています。`,
        instruction: null,
        onset: entry.reportDatetime ?? null,
        effective,
        // JMA warnings run until explicitly lifted rather than to a published expiry time.
        expires: null,
        sender: bulletins[0]?.publishingOffice ?? '気象庁',
        areaDescription,
        language: 'ja',
        provenance,
      })
    }

    alerts.sort((a, b) => JP_SORT_RANK[a.severity] - JP_SORT_RANK[b.severity])

    const limit = query.limit ?? 10
    const capped = alerts.slice(0, limit)
    const feedAgeMs = newestReport === undefined ? undefined : Date.now() - newestReport
    const feedSuspect = feedAgeMs !== undefined && feedAgeMs > FEED_SUSPECT_AFTER_MS

    return {
      alerts: capped,
      totalActiveCount: alerts.length,
      // JMA warnings have no expiry to have passed; they are lifted, and a lifted one is not here.
      expiredCount: 0,
      coverage: feedSuspect
        ? {
            state: 'partial',
            reason: 'source_failed',
            detail: `The JMA feed for ${office.name} has not been republished in ${Math.floor((feedAgeMs ?? 0) / 86_400_000)} days, although it advertises a one-minute refresh. Treat this as a possibly dead endpoint, not as an absence of warnings.`,
            failedSources: [{ sourceId: this.sourceId, error: 'feed not republished recently' }],
          }
        : capped.length < alerts.length
          ? {
              state: 'partial',
              reason: 'result_cap',
              detail: `${alerts.length - capped.length} of ${alerts.length} warnings in force were omitted to fit the result cap.`,
              failedSources: [],
            }
          : { state: 'full', failedSources: [] },
      staleness: {
        stale: feedSuspect,
        ageMs: feedAgeMs,
        expectedRefreshMs: this.meta.expectedRefreshMs,
      },
    }
  }
}
