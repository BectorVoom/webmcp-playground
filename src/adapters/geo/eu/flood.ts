import { Effect } from 'effect'
import type {
  FloodDataPort,
  FloodQuery,
  FloodQueryResult,
  ProviderMeta,
} from '../../../ports/FloodData'
import type { FloodZone } from '../../../domain/hazard'
import type { Coverage, Staleness } from '../../../domain/provenance'
import { SourceUnavailable, type GeoError } from '../../../domain/geo-errors'

/**
 * Europe's flood forecast, from Copernicus CEMS.
 *
 * This slot was empty for a long time, and the reason is worth keeping written down because it
 * still shapes what this provider is. EFAS is the European product — 1.5 km, purpose-built for the
 * continent — and it is behind CEMS authentication; what a token buys a non-partner is EFAS with a
 * thirty-day delay, which for a product whose longest lead time is fifteen days means every
 * forecast it can fetch expired a fortnight ago. A forecast of the past is not a forecast, so this
 * uses **GloFAS** instead: the global arm of the same programme, coarser at 0.05°, and published
 * daily in time to act on.
 *
 * What it reports is not a discharge but an exceedance: the server scores the forecast ensemble
 * against each cell's own 1991–2020 flood frequency curve, so a zone means "at least 30% of the
 * ensemble puts this cell above a flood it sees once in N years", which is the same statement
 * EFAS and GloFAS make in their own notifications.
 *
 * Everything real happens on the server (`/api/geo/cems-forecast`). It has to: the store is
 * token-authenticated, answers in queued jobs rather than replies, and returns NetCDF. This class
 * is the thin end of that — and it treats "not retrieved yet" as a coverage statement rather than
 * an empty map, because "we have not fetched this" and "nothing here will flood" are exactly the
 * two answers that must never be confused.
 */

const API_URL = '/api/geo/cems-forecast'

export const EU_FORECAST_SOURCE_ID = 'eu.copernicus.glofas-forecast'

interface ForecastResponse {
  readonly state?: 'ready' | 'pending' | 'unconfigured' | 'failed'
  readonly detail?: string
  readonly zones?: ReadonlyArray<FloodZone>
  readonly coverage?: Coverage
  readonly staleness?: Staleness
}

export class EuFloodForecastProvider implements FloodDataPort {
  readonly sourceId = EU_FORECAST_SOURCE_ID
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Copernicus GloFAS — ensemble river discharge forecast',
    docsUrl: 'https://ewds.climate.copernicus.eu/datasets/cems-glofas-forecast',
    vintage: 'GloFAS operational, scored against 1991–2020 reanalysis',
    licence: 'Copernicus Open Access (free reuse with attribution)',
    attribution:
      'Copernicus Emergency Management Service — Global Flood Awareness System (GloFAS), via the ECMWF Data Store',
    // A new run every day. Older than that and the map is showing yesterday's weather.
    expectedRefreshMs: 86_400_000,
  }

  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    return Effect.gen(this, function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          this.fetchImpl(API_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              at: { latitude: query.at.latitude, longitude: query.at.longitude },
              radiusKm: query.radiusKm,
            }),
            signal: query.signal,
          }),
        catch: (err) =>
          new SourceUnavailable({
            sourceId: this.sourceId,
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          }),
      })

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (err) =>
          new SourceUnavailable({
            sourceId: this.sourceId,
            message: `Failed to read the forecast response: ${String(err)}`,
            cause: err,
          }),
      })

      // A 4xx or 5xx here is this server misbehaving, not Copernicus, and it is a real error —
      // unlike a 202, which is the normal answer while a retrieval is still queued.
      if (!response.ok && response.status !== 202) {
        return yield* Effect.fail(
          new SourceUnavailable({
            sourceId: this.sourceId,
            message: `The forecast route returned HTTP ${response.status}: ${text.slice(0, 300)}`,
          }),
        )
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as ForecastResponse,
        catch: () =>
          new SourceUnavailable({
            sourceId: this.sourceId,
            message: `The forecast route returned a body that is not JSON: ${text.slice(0, 200)}`,
          }),
      })

      if (parsed.state !== 'ready') return this.notReady(parsed, query)

      return {
        zones: parsed.zones ?? [],
        coverage: parsed.coverage ?? { state: 'full', failedSources: [] },
        staleness: parsed.staleness ?? { stale: false },
      }
    })
  }

  /**
   * An answer that is not a hazard map, said as one.
   *
   * All three of these return no zones, and none of them means the area is safe — so each carries
   * the reason in `coverage.detail` and none is left as a bare empty list. `pending` in particular
   * is temporary and worth asking about again, which is the one thing an empty map would never
   * convey.
   */
  private notReady(parsed: ForecastResponse, query: FloodQuery): FloodQueryResult {
    const detail =
      parsed.detail ??
      'The European flood forecast could not be produced, for a reason the server did not give.'

    const coverage: Coverage = {
      state: 'none',
      reason: parsed.state === 'failed' ? 'source_failed' : 'no_data_for_area',
      detail:
        `${detail} This is a missing forecast, not a finding that the area within ` +
        `${query.radiusKm} km is safe.`,
      failedSources:
        parsed.state === 'failed' ? [{ sourceId: this.sourceId, error: detail }] : [],
    }

    return { zones: [], coverage, staleness: { stale: false } }
  }
}
