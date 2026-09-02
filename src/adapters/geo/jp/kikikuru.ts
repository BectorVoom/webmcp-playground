import { Effect } from 'effect'
import type { DepthBand, FloodZone, HazardClass } from '../../../domain/hazard'
import type { Coverage, Provenance } from '../../../domain/provenance'
import type { FloodDataPort, FloodQuery, FloodQueryResult, ProviderMeta } from '../../../ports/FloodData'
import { SourceUnavailable, UpstreamPayloadInvalid, type GeoError } from '../../../domain/geo-errors'
import { getCoveringTiles } from '../../../lib/geometry/tiles'
import { classifyRasterTile, type LegendClass } from '../../../lib/geometry/raster'
import { rasterTilesToFloodZones } from '../../../lib/geometry/contour'
import { fetchRasterViaProxy, fetchViaProxy, parseUpstreamJson } from '../proxy-client'
import {
  cellMetresForRadius,
  decodeWithCanvas,
  FETCH_CONCURRENCY,
  type DecodedTile,
  type TileDecoder,
} from './flood'

/**
 * 気象庁 キキクル（浸水害・洪水害の危険度分布）.
 *
 * The first thing in this application that says what is dangerous **now**. Everything else in the
 * Japanese flood path is `jp.gsi.flood-l2`, an assumed-maximum planning map with no valid time: it
 * answers "what would a once-in-a-millennium event inundate", which is the right question the week
 * before and the wrong one during a 大雨特別警報. キキクル is JMA's real-time risk grid, updated
 * every ten minutes, and it is what turns this from a hazard atlas into a warning tool.
 *
 * Two products, because the user is in danger from either and cannot be expected to know which:
 * `inund` is 浸水害 (surface water — drains overwhelmed, water rising in the street) and `flood`
 * is 洪水害 (river flooding). They are queried together and merged at the most severe level found,
 * so an area that is level 3 for one and level 4 for the other reports level 4.
 */

export type KikikuruElement = 'inund' | 'flood'

/**
 * The risk levels, read out of JMA's own tiles.
 *
 * These tiles are 4-bit palette PNGs and the `PLTE` chunk carries the whole table whatever the
 * tile happens to contain — so the palette was taken from the bytes JMA serves rather than
 * transcribed from documentation, and it can be re-checked from any tile, including an empty one
 * on a calm day. That matters here: the last colour table in this codebase to come from
 * documentation was wrong on five of its six rows.
 *
 * Level 1 (今後の情報に注意) is painted transparent — the absence of risk, not a colour.
 */
export const KIKIKURU_LEGEND: ReadonlyArray<LegendClass> = [
  {
    id: 'level2',
    name: '注意 (level 2) — conditions worth watching',
    r: 242,
    g: 231,
    b: 0, // #F2E700
    hazardClass: 'low',
    depth: { minMetres: 0 },
  },
  {
    id: 'level3',
    name: '警戒 (level 3) — 高齢者等避難 territory',
    r: 255,
    g: 40,
    b: 0, // #FF2800
    hazardClass: 'moderate',
    depth: { minMetres: 0 },
  },
  {
    id: 'level4',
    name: '危険 (level 4) — 避難指示 territory, leave now',
    r: 170,
    g: 0,
    b: 170, // #AA00AA
    hazardClass: 'high',
    depth: { minMetres: 0 },
  },
  {
    id: 'level5',
    name: '災害切迫 (level 5) — a disaster is already occurring',
    r: 12,
    g: 0,
    b: 12, // #0C000C
    hazardClass: 'extreme',
    depth: { minMetres: 0 },
  },
]

/** Japanese for each class, for a result a reader in Japan can act on. */
export const KIKIKURU_LEVEL_LABEL: Record<HazardClass, string> = {
  low: '注意（レベル2）',
  moderate: '警戒（レベル3）',
  high: '危険（レベル4）',
  extreme: '災害切迫（レベル5）',
  unclassified: '判読不能',
}

/**
 * Zoom 12. キキクル is published on a 1 km mesh, so a z12 pixel (~38 m at this latitude) is already
 * finer than the data; going higher would fetch four times the tiles to resolve nothing.
 */
const TILE_ZOOM = 12
const TILE_CAP = 64

const TIMES_URL = 'https://www.jma.go.jp/bosai/jmatile/data/risk/targetTimes.json'

export const KIKIKURU_TILE_URL = (
  time: KikikuruTime,
  element: KikikuruElement,
  z: number,
  x: number,
  y: number,
): string =>
  `https://www.jma.go.jp/bosai/jmatile/data/risk/${time.basetime}/${time.member}/${time.validtime}/surf/${element}/${z}/${x}/${y}.png`

export interface KikikuruTime {
  readonly basetime: string
  readonly validtime: string
  readonly member: string
}

interface TargetTimeEntry {
  readonly basetime?: string
  readonly validtime?: string
  readonly member?: string
  readonly elements?: ReadonlyArray<string>
}

/**
 * `20260830013000`, in **UTC**.
 *
 * Worth stating because most of JMA's `bosai` JSON is stamped in JST and this one is not. Read as
 * JST it puts every reading nine hours in the past, which sails straight through as a plausible
 * number and marks a feed that is thirty seconds old as badly stale. Confirmed against the wall
 * clock: the index served `20260830013000` at 10:31 JST, which is 01:31Z.
 */
export const parseJmaTimestamp = (stamp: string): number | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
}

/**
 * The newest entry that actually carries the elements we need.
 *
 * `immed0` is the current analysis and the later `immed`N are the preceding ten-minute steps; the
 * index is ordered newest first, but that is a property of today's feed rather than a promise, so
 * this picks by timestamp instead of by position.
 */
export const pickLatestTime = (
  entries: ReadonlyArray<TargetTimeEntry>,
  elements: ReadonlyArray<KikikuruElement>,
): KikikuruTime | undefined => {
  let best: { time: KikikuruTime; at: number } | undefined
  for (const entry of entries) {
    if (!entry.basetime || !entry.validtime || !entry.member) continue
    if (!elements.every((el) => entry.elements?.includes(el))) continue
    const at = parseJmaTimestamp(entry.validtime)
    if (at === undefined) continue
    if (!best || at > best.at) {
      best = { time: { basetime: entry.basetime, validtime: entry.validtime, member: entry.member }, at }
    }
  }
  return best?.time
}

const SEVERITY: Record<HazardClass, number> = {
  unclassified: 1,
  low: 2,
  moderate: 3,
  high: 4,
  extreme: 5,
}

export class JpKikikuruProvider implements FloodDataPort {
  readonly sourceId = 'jp.jma.kikikuru'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: '気象庁 キキクル（浸水害・洪水害の危険度分布）',
    docsUrl: 'https://www.jma.go.jp/bosai/risk/',
    licence: 'JMA Terms of Use',
    attribution: '気象庁 キキクル（危険度分布）',
    // Republished every ten minutes; past twice that it is worth saying the picture has aged.
    expectedRefreshMs: 600_000,
  }

  private readonly fetchImpl: typeof fetch
  private readonly decodeTile: TileDecoder
  private readonly elements: ReadonlyArray<KikikuruElement>

  constructor(
    fetchImpl?: typeof fetch,
    decodeTile?: TileDecoder,
    elements: ReadonlyArray<KikikuruElement> = ['inund', 'flood'],
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    // Shares the flood provider's injected decoder for the same reason: jsdom has no canvas.
    this.decodeTile = decodeTile ?? decodeWithCanvas
    this.elements = elements
  }

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    const cover = getCoveringTiles(query.at, query.radiusKm, TILE_ZOOM, TILE_CAP)

    return this.latestTime(query.signal).pipe(
      Effect.flatMap((time) =>
        Effect.tryPromise({
          try: () => this.loadTiles(time, cover.tiles, query.signal),
          catch: (err) =>
            new SourceUnavailable({
              sourceId: this.sourceId,
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        }).pipe(Effect.map((loaded) => this.toResult(time, loaded, query))),
      ),
    )
  }

  /** The index of what JMA currently has published. */
  private latestTime(signal: AbortSignal | undefined): Effect.Effect<KikikuruTime, GeoError> {
    return fetchViaProxy(this.fetchImpl, {
      kind: 'flood',
      at: { latitude: 0, longitude: 0 },
      sourceId: this.sourceId,
      upstreamUrl: TIMES_URL,
      signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) {
          return Effect.fail(
            new SourceUnavailable({
              sourceId: this.sourceId,
              message: 'Server is in fixture mode; キキクル has no recorded index to replay.',
            }),
          )
        }
        return parseUpstreamJson<ReadonlyArray<TargetTimeEntry>>(this.sourceId, response.text).pipe(
          Effect.flatMap((entries) => {
            const time = pickLatestTime(Array.isArray(entries) ? entries : [], this.elements)
            return time
              ? Effect.succeed(time)
              : Effect.fail(
                  new UpstreamPayloadInvalid({
                    sourceId: this.sourceId,
                    path: 'targetTimes.json',
                    expected: `an entry carrying ${this.elements.join(' and ')}`,
                  }),
                )
          }),
        )
      }),
    )
  }

  private async loadTiles(
    time: KikikuruTime,
    tiles: ReadonlyArray<{ z: number; x: number; y: number }>,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly classified: Array<{
      z: number
      x: number
      y: number
      grid: Array<HazardClass | null>
      depthGrid: Array<DepthBand | undefined>
      width: number
      height: number
    }>
    readonly failed: number
    readonly missing: number
    readonly attempted: number
    readonly undecodable: boolean
    readonly riskPixels: number
  }> {
    const merged = new Map<
      string,
      { z: number; x: number; y: number; grid: Array<HazardClass | null>; width: number; height: number }
    >()
    let failed = 0
    let missing = 0
    let undecodable = false
    let riskPixels = 0

    const work = tiles.flatMap((tile) => this.elements.map((element) => ({ tile, element })))
    const attempted = work.length

    // Windowed, like the GSI provider: a 20 km query is two products over dozens of tiles, and
    // asking a public government service for all of them at once is what usage policies forbid.
    // Sequentially would be worse in the other direction — it took minutes.
    for (let start = 0; start < work.length; start += FETCH_CONCURRENCY) {
      const window = work.slice(start, start + FETCH_CONCURRENCY)
      const results = await Promise.all(
        window.map(async ({ tile, element }) => ({
          tile,
          decoded: await this.fetchTile(time, element, tile, signal),
        })),
      )

      for (const { tile, decoded } of results) {
        // JMA answers 404 where the mesh has nothing to say — sea, or outside the product. That is
        // data, not a failure, and counting it as one made a calm day look like an outage.
        if (decoded === 'missing') {
          missing++
          continue
        }
        if (decoded === 'failed') {
          failed++
          continue
        }
        if (decoded === null) {
          undecodable = true
          continue
        }

        const { grid } = classifyRasterTile(decoded.data, decoded.width, decoded.height, KIKIKURU_LEGEND)
        const key = `${tile.x}/${tile.y}`
        const existing = merged.get(key)
        if (!existing) {
          merged.set(key, { ...tile, grid, width: decoded.width, height: decoded.height })
          continue
        }
        // 浸水害 and 洪水害 are separate hazards over the same ground. A reader needs the worse of
        // the two, not one of them chosen by which happened to be fetched second.
        for (let i = 0; i < existing.grid.length; i++) {
          const next = grid[i]
          const prev = existing.grid[i]
          if (next && (!prev || SEVERITY[next] > SEVERITY[prev])) existing.grid[i] = next
        }
      }
    }

    const classified = [...merged.values()].map((tile) => {
      for (const cell of tile.grid) if (cell) riskPixels++
      return { ...tile, depthGrid: new Array<DepthBand | undefined>(tile.grid.length).fill(undefined) }
    })

    return { classified, failed, missing, attempted, undecodable, riskPixels }
  }

  private async fetchTile(
    time: KikikuruTime,
    element: KikikuruElement,
    tile: { z: number; x: number; y: number },
    signal: AbortSignal | undefined,
  ): Promise<DecodedTile | null | 'failed' | 'missing'> {
    const url = KIKIKURU_TILE_URL(time, element, tile.z, tile.x, tile.y)
    const response = await Effect.runPromise(
      Effect.either(
        fetchRasterViaProxy(this.fetchImpl, {
          sourceId: this.sourceId,
          upstreamUrl: url,
          // Republished every ten minutes, so caching it for a day would show yesterday's danger.
          ttlMs: 300_000,
          signal,
        }),
      ),
    )
    if (response._tag === 'Left') {
      return response.left._tag === 'SourceUnavailable' && /HTTP 404/.test(response.left.message)
        ? 'missing'
        : 'failed'
    }
    if (response.right.servedFromFixture) return null
    return this.decodeTile(response.right.bytes)
  }

  private toResult(
    time: KikikuruTime,
    loaded: {
      readonly classified: Array<{
        z: number
        x: number
        y: number
        grid: Array<HazardClass | null>
        depthGrid: Array<DepthBand | undefined>
        width: number
        height: number
      }>
      readonly failed: number
      readonly missing: number
      readonly attempted: number
      readonly undecodable: boolean
      readonly riskPixels: number
    },
    query: FloodQuery,
  ): FloodQueryResult {
    const issuedAt = parseJmaTimestamp(time.validtime)
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: 'https://www.jma.go.jp/bosai/jmatile/data/risk/{basetime}/{member}/{validtime}/surf/{element}/{z}/{x}/{y}.png',
      issuedAt,
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    const zones: ReadonlyArray<FloodZone> = rasterTilesToFloodZones(
      loaded.classified,
      provenance,
      // Carried into ZoneKind by the vectoriser as a scenario label; corrected to a forecast below,
      // because a risk grid with a valid time is exactly what `forecast` is for (ADR-2).
      'キキクル risk distribution',
      { cellMetres: cellMetresForRadius(query.radiusKm) },
    ).map((zone) => ({
      ...zone,
      id: `kikikuru-${zone.hazardClass}`,
      kind: {
        kind: 'forecast' as const,
        validFrom: issuedAt ?? Date.now(),
        // Republished every ten minutes; beyond that this picture is superseded, not merely old.
        validTo: (issuedAt ?? Date.now()) + 600_000,
      },
      // A risk level is not a depth, and inventing one would be the same failure as inventing a
      // hazard zone. The band stays empty and the level is carried by `hazardClass`.
      depth: undefined,
    }))

    const ageMs = issuedAt === undefined ? undefined : Math.max(0, Date.now() - issuedAt)
    /**
     * Three cycles, not two.
     *
     * JMA analyses every ten minutes but publishes with a lag, so a reading twenty minutes old is
     * the normal state of this feed rather than a fault — flagging it stale put a "flood data is
     * STALE" banner over a perfectly current picture, which is the boy-who-cried-wolf failure that
     * ends with a reader ignoring the banner on the day it means something. Half an hour without a
     * new analysis is a feed that has actually stopped.
     */
    const staleAfterMs = (this.meta.expectedRefreshMs ?? 600_000) * 3

    return {
      zones,
      coverage: this.describeCoverage(loaded, zones.length, query.radiusKm),
      staleness: {
        stale: ageMs !== undefined && ageMs > staleAfterMs,
        ageMs,
        expectedRefreshMs: this.meta.expectedRefreshMs,
      },
    }
  }

  private describeCoverage(
    loaded: {
      readonly failed: number
      readonly missing: number
      readonly attempted: number
      readonly undecodable: boolean
      readonly riskPixels: number
    },
    zoneCount: number,
    radiusKm: number,
  ): Coverage {
    if (loaded.undecodable) {
      return {
        state: 'none',
        reason: 'source_failed',
        detail:
          'キキクル tiles could not be decoded here, so no real-time risk level was read. This is not a report that the risk is low.',
        failedSources: [{ sourceId: this.sourceId, error: 'raster could not be decoded' }],
      }
    }
    // Only when nothing at all got through. Reporting an outage because *some* requests failed,
    // while the rest legitimately showed no risk, turns a quiet day into a false alarm about the
    // tool itself — and a reader who distrusts the tool stops reading the warnings too.
    if (loaded.attempted > 0 && loaded.failed === loaded.attempted) {
      return {
        state: 'none',
        reason: 'source_failed',
        detail: `Every キキクル tile request failed, so no real-time risk level was read for this area.`,
        failedSources: [{ sourceId: this.sourceId, error: `${loaded.failed} tile fetches failed` }],
      }
    }
    if (zoneCount === 0) {
      return {
        state: 'full',
        detail: `気象庁 publishes no 浸水害 or 洪水害 risk above level 1 within ${radiusKm} km right now. That is the current picture, and it can change within ten minutes.`,
        failedSources: [],
      }
    }
    if (loaded.failed > 0) {
      return {
        state: 'partial',
        reason: 'source_failed',
        detail: `${loaded.failed} キキクル tile(s) could not be fetched; the risk picture here is incomplete.`,
        failedSources: [{ sourceId: this.sourceId, error: `${loaded.failed} tile fetches failed` }],
      }
    }
    return { state: 'full', failedSources: [] }
  }
}
