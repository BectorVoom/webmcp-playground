import { Effect } from 'effect'
import type { HazardClass, DepthBand, FloodZone } from '../../../domain/hazard'
import type { Coverage, Provenance } from '../../../domain/provenance'
import type {
  FloodDataPort,
  FloodQuery,
  FloodQueryResult,
  ProviderMeta,
} from '../../../ports/FloodData'
import { SourceUnavailable, type GeoError } from '../../../domain/geo-errors'
import { getCoveringTiles } from '../../../lib/geometry/tiles'
import { classifyRasterTile } from '../../../lib/geometry/raster'
import { rasterTilesToFloodZones } from '../../../lib/geometry/contour'
import { FixtureFloodProvider } from '../fixture/fixture-flood'

/** A decoded raster tile: RGBA bytes plus its dimensions. */
export interface DecodedTile {
  readonly data: Uint8ClampedArray | Uint8Array
  readonly width: number
  readonly height: number
}

export type TileDecoder = (bytes: ArrayBuffer) => Promise<DecodedTile | null>

/**
 * Zoom 14 is the working compromise.
 *
 * GSI serves this raster from z2 to z17, painted in flat palette colours at every one of them, so
 * the choice trades tile count against ground detail and nothing else. At z14 a tile is ~2.4 km
 * across and ~9 m per pixel.
 *
 * A 20 km radius needs 441 tiles at this zoom, which `DEFAULT_TILE_CAP` now covers; the cap was 64,
 * so the widest queries examined 15% of their own circle. Dropping a zoom to cover more ground
 * with fewer tiles does not help as much as it looks: GSI's lower-zoom tiles are generalised, not
 * emptier, so each one costs about the same to vectorise as one at z14.
 */
const TILE_ZOOM = 14

/**
 * How many tiles one query may fetch.
 *
 * 441 is what a 20 km radius — the widest the tools allow (R1.9) — actually needs at this zoom, so
 * the default covers the whole circle at every radius with headroom. It was 64, which covered 15%
 * of a 20 km query: the flood map simply stopped part-way out, and only `coverage` said so.
 *
 * Raising it is only affordable because the working cell scales with the radius; see
 * `cellMetresForRadius`. At a fixed 40 m cell, 441 tiles takes ~5 s to vectorise and lands at
 * ~64 000 vertices against a 20 000 budget (N5).
 */
export const DEFAULT_TILE_CAP = 512

let configuredTileCap = DEFAULT_TILE_CAP

/**
 * Applies the server's `GEO_TILE_CAP`. The server owns this number because it owns the proxy that
 * pays for the requests; the client asks for it once, through `/api/geo/providers`.
 */
export const setGsiTileCap = (cap: number): void => {
  if (Number.isFinite(cap) && cap > 0) configuredTileCap = Math.floor(cap)
}

/** How many tile fetches are in flight at once. Shared with the キキクル provider. */
export const FETCH_CONCURRENCY = 12

/**
 * Ground size of one vectorised cell, chosen from the radius being asked about.
 *
 * Vertices after simplification are governed by how many separate polygons come out, not by how
 * intricate each one is — Douglas-Peucker cannot take a ring below four points, so 13 000 rings is
 * 50 000 vertices whatever the tolerance. Ring count scales with area over cell², so holding the
 * cell proportional to the radius keeps the rendered layer at roughly constant cost however wide
 * the question, which is what lets the tile cap cover the whole circle.
 *
 * Measured over the full 20 km around Fukui — a flood plain, so close to the worst case there is:
 * 120 m cells give 3 336 rings and 19 009 vertices after simplification, inside the 20 000 budget;
 * 40 m cells give 13 284 rings and 63 539, which no tolerance can bring back down.
 *
 * The floor is 40 m, not the raster's own ~9 m. Going finer is where the cost is: a dense tile
 * takes ~450 ms to vectorise at 9 m and ~46 ms at 40 m, so a close-in query over a flood plain —
 * every tile dense — would spend seconds to draw detail below the resolution of the data behind it.
 * The ceiling stops a wide query dissolving into blocks. Coarsening always keeps the most severe
 * class in a cell, so the error it introduces is always towards deeper water, never shallower.
 */
export const cellMetresForRadius = (radiusKm: number): number => {
  const scaled = (Number.isFinite(radiusKm) ? radiusKm : 20) * 7
  return Math.min(120, Math.max(40, scaled))
}

export const decodeWithCanvas: TileDecoder = async (bytes) => {
  // Browser-only. `createImageBitmap` and `OffscreenCanvas` do not exist under jsdom, which is why
  // the decoder is injectable rather than reached for directly.
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null

  // `colorSpaceConversion: 'none'` is load-bearing. These tiles carry sRGB and gAMA chunks, and a
  // browser is free to colour-manage them on decode; the classifier matches palette colours to
  // within 12 units, so a few units of drift would silently turn mapped inundation into
  // "unclassified". Ask for the bytes GSI painted, not a display-corrected version of them.
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { data: image.data, width: image.width, height: image.height }
  } finally {
    bitmap.close()
  }
}

export const GSI_TILE_URL = (z: number, x: number, y: number): string =>
  `/api/geo/tiles/jp-flood/${z}/${x}/${y}.png`

/**
 * Flood inundation zones from the GSI hazard raster, for anywhere in Japan.
 *
 * GSI publishes 洪水浸水想定区域（想定最大規模）as coloured PNG tiles rather than as vectors, so
 * the pipeline is: pick the tiles covering the query circle, fetch them, classify each pixel
 * against the official depth legend, and vectorise the result. Every piece of that already existed
 * in `lib/geometry` and was simply never connected to a tile source.
 *
 * This replaces a provider that synthesised a polygon centred on whatever coordinate it was handed
 * whenever the recorded fixtures were far away — which, outside Tokyo, was everywhere, and which
 * told every user in Japan they were standing in a 3–5 m inundation zone.
 */
export class JpFloodProvider implements FloodDataPort {
  readonly sourceId = 'jp.gsi.flood-l2'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: '国土地理院 洪水浸水想定区域（想定最大規模）',
    docsUrl: 'https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html',
    vintage: '2025-03',
    licence: 'GSI Content Terms of Use',
    attribution: '国土地理院 ハザードマップポータル（洪水浸水想定区域データ）',
    expectedRefreshMs: 86_400_000 * 365,
  }

  private readonly fixture = new FixtureFloodProvider('jp')
  private readonly fetchImpl: typeof fetch
  private readonly decodeTile: TileDecoder
  private readonly tileCap: number | undefined

  constructor(fetchImpl?: typeof fetch, decodeTile?: TileDecoder, tileCap?: number) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.decodeTile = decodeTile ?? decodeWithCanvas
    this.tileCap = tileCap
  }

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    const cover = getCoveringTiles(
      query.at,
      query.radiusKm,
      TILE_ZOOM,
      this.tileCap ?? configuredTileCap,
    )

    return Effect.tryPromise({
      try: () => this.loadTiles(cover.tiles, query.signal),
      catch: (err) =>
        new SourceUnavailable({
          sourceId: this.sourceId,
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    }).pipe(
      Effect.flatMap((loaded) => {
        // Nothing decoded and nothing 404'd means we never reached a tile server — a failure, not
        // an all-clear. `undecodable` is the browser telling us it has no canvas.
        if (loaded.undecodable) return this.fixture.zonesWithin(query)
        if (loaded.classified.length === 0 && loaded.failed === cover.tiles.length) {
          return Effect.fail(
            new SourceUnavailable({
              sourceId: this.sourceId,
              message: `No GSI hazard tile could be fetched for this area (${loaded.failed} attempted).`,
            }),
          )
        }
        return Effect.succeed(this.toResult(loaded, cover, query))
      }),
    )
  }

  private async loadTiles(
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
    readonly undecodable: boolean
    readonly inundatedPixels: number
    readonly unreadablePixels: number
  }> {
    const classified: Array<{
      z: number
      x: number
      y: number
      grid: Array<HazardClass | null>
      depthGrid: Array<DepthBand | undefined>
      width: number
      height: number
    }> = []
    let failed = 0
    let missing = 0
    let undecodable = false
    let inundatedPixels = 0
    let unreadablePixels = 0

    const loadOne = async (tile: { z: number; x: number; y: number }) => {
      const response = await this.fetchImpl(GSI_TILE_URL(tile.z, tile.x, tile.y), { signal })
      // GSI returns 404 for a tile with no mapped inundation. That is data, not an error.
      if (response.status === 404) return { tile, kind: 'missing' as const }
      if (!response.ok) return { tile, kind: 'failed' as const }
      const bytes = await response.arrayBuffer()
      const decoded = await this.decodeTile(bytes)
      return decoded ? { tile, kind: 'ok' as const, decoded } : { tile, kind: 'undecodable' as const }
    }

    /**
     * Windowed rather than all at once. The cap is now high enough to cover a whole 20 km circle,
     * and firing 441 simultaneous requests at a public government tile server is the kind of thing
     * usage policies exist to forbid — the proxy caches for a day, so the burst buys nothing but
     * the risk of being throttled.
     */
    const results: Array<Awaited<ReturnType<typeof loadOne>>> = []
    for (let start = 0; start < tiles.length; start += FETCH_CONCURRENCY) {
      const window = tiles.slice(start, start + FETCH_CONCURRENCY)
      results.push(...(await Promise.all(window.map(loadOne))))
    }

    for (const result of results) {
      if (result.kind === 'missing') {
        missing++
        continue
      }
      if (result.kind === 'failed') {
        failed++
        continue
      }
      if (result.kind === 'undecodable') {
        undecodable = true
        continue
      }
      const { grid, depthGrid, classPixelCounts } = classifyRasterTile(
        result.decoded.data,
        result.decoded.width,
        result.decoded.height,
      )
      // Tracked so a tile painted in colours outside the published legend is reported rather than
      // quietly rendered as a grey blob. Two such fills do occur in GSI's own data — see the
      // legend note in `lib/geometry/raster.ts`.
      unreadablePixels += classPixelCounts.unclassified
      inundatedPixels +=
        classPixelCounts.low +
        classPixelCounts.moderate +
        classPixelCounts.high +
        classPixelCounts.extreme +
        classPixelCounts.unclassified
      classified.push({
        z: result.tile.z,
        x: result.tile.x,
        y: result.tile.y,
        grid,
        depthGrid,
        width: result.decoded.width,
        height: result.decoded.height,
      })
    }

    return { classified, failed, missing, undecodable, inundatedPixels, unreadablePixels }
  }

  private toResult(
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
      readonly inundatedPixels: number
      readonly unreadablePixels: number
    },
    cover: { readonly tiles: ReadonlyArray<unknown>; readonly totalNeeded: number; readonly capApplied: boolean },
    query: FloodQuery,
  ): FloodQueryResult {
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png',
      datasetVintage: this.meta.vintage,
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    const zones: ReadonlyArray<FloodZone> = rasterTilesToFloodZones(
      loaded.classified,
      provenance,
      'L2 assumed maximum',
      { cellMetres: cellMetresForRadius(query.radiusKm) },
    )

    return {
      zones,
      coverage: this.describeCoverage(loaded, cover, zones.length, query.radiusKm),
      // A design-event hazard map has a vintage, not an issue time; it does not go stale between
      // queries the way a forecast does.
      staleness: { stale: false },
    }
  }

  private describeCoverage(
    loaded: {
      readonly failed: number
      readonly missing: number
      readonly classified: ReadonlyArray<unknown>
      readonly inundatedPixels: number
      readonly unreadablePixels: number
    },
    cover: { readonly tiles: ReadonlyArray<unknown>; readonly totalNeeded: number; readonly capApplied: boolean },
    zoneCount: number,
    radiusKm: number,
  ): Coverage {
    const attempted = cover.tiles.length

    if (loaded.failed > 0) {
      return {
        state: 'partial',
        reason: 'source_failed',
        detail: `${loaded.failed} of ${attempted} hazard tiles could not be fetched; this map is incomplete.`,
        failedSources: [{ sourceId: this.sourceId, error: `${loaded.failed} tile fetches failed` }],
      }
    }

    // A colour GSI paints that the legend does not list. Rare — under 1% of mapped area in the
    // verification sample — but it is mapped inundation whose depth we cannot state, so it is
    // reported instead of being passed off as read.
    const unreadableShare =
      loaded.inundatedPixels > 0 ? loaded.unreadablePixels / loaded.inundatedPixels : 0
    if (unreadableShare > 0.01) {
      return {
        state: 'partial',
        reason: 'no_data_for_area',
        detail: `${Math.round(unreadableShare * 100)}% of the mapped inundation here is painted in a colour outside the published GSI depth legend; it is shown as inundated but its depth could not be read.`,
        failedSources: [],
      }
    }

    if (cover.capApplied) {
      return {
        state: 'partial',
        reason: 'tile_cap',
        detail: `${attempted} of ${cover.totalNeeded} tiles analysed; the outer part of the ${radiusKm} km radius was not examined.`,
        failedSources: [],
      }
    }

    if (zoneCount === 0) {
      return {
        state: 'full',
        detail: `GSI publishes no assumed-maximum inundation within ${radiusKm} km of this location. That means this area is outside the mapped flood extent, not that it cannot flood.`,
        failedSources: [],
      }
    }

    return { state: 'full', failedSources: [] }
  }
}
