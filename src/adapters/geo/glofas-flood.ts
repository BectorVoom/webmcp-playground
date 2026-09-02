import { Effect } from 'effect'
import type { BBox, LonLat } from '../../domain/geo'
import type { DepthBand, FloodZone, HazardClass } from '../../domain/hazard'
import type { Coverage, Provenance } from '../../domain/provenance'
import type { FloodDataPort, FloodQuery, FloodQueryResult, ProviderMeta } from '../../ports/FloodData'
import { SourceUnavailable, type GeoError } from '../../domain/geo-errors'
import { vectoriseTileGrid } from '../../lib/geometry/contour'
import { createCircleBBox } from '../../lib/geometry/circle'
import { fetchRasterViaProxy } from './proxy-client'
import { cellMetresForRadius, decodeWithCanvas, type DecodedTile, type TileDecoder } from './jp/flood'

/**
 * Copernicus **GloFAS** — Global Flood Awareness System — `FloodHazard100y`.
 *
 * The first flood source here that covers anywhere on earth. Every other one stops at a national
 * border: GSI ends at Japan's coastline, FEMA at the United States', and the European slot has been
 * empty since the survey found EFAS to be behind CEMS authentication. GloFAS publishes an open WMS
 * that needs no key, which is the only reason this is reachable at all.
 *
 * What it is: the area a flood with a **100-year return period** would inundate, from GloFAS
 * climatology. That is a planning scenario like GSI's assumed-maximum map, not a forecast — it says
 * nothing about today. It is a coarser and less authoritative map than a national one wherever a
 * national one exists, which is why it is queried alongside them rather than instead of them: a
 * source that disagrees with GSI about Fukui is information, and hiding it would not be (R2.2).
 */

const OWS_URL = 'https://ows.globalfloods.eu/glofas-ows/ows'
const LAYER = 'FloodHazard100y'

/**
 * The layer's palette, read from the `PLTE` chunk of actual `GetMap` responses rather than from
 * documentation, and then probed to find out what each shade means.
 *
 * The shades are not a depth ramp. Sampling Lake Biwa, the Fukui plain, the Dhaka delta, open ocean
 * and the Sahara showed `#3338FF` covering 54% of a permanent lake and under 2% of a flood plain,
 * while the paler blues do the reverse — so the deep blue is the **permanent water body** the
 * layer's own abstract mentions ("derived from the Global Lakes and Wetlands Database and from the
 * Natural Earth lakes map"), and the paler ones are the 100-year inundation extent.
 *
 * That distinction is the whole reason this was worth probing: painting `#3338FF` as flood hazard
 * would report Lake Biwa as an area that is going to flood.
 */
const GLOFAS_HAZARD_BLUES = [
  { id: '#B8DBFF', r: 184, g: 219, b: 255 },
  { id: '#9ACCFF', r: 154, g: 204, b: 255 },
  { id: '#6799FF', r: 103, g: 153, b: 255 },
] as const

/** Lakes and permanent river channels. Real water, but not a flood forecast about it. */
const GLOFAS_PERMANENT_WATER = { id: '#3338FF', r: 51, g: 56, b: 255 } as const

/**
 * Wider than the GSI classifier's, because MapServer quantises a fresh palette per request: the
 * same three requests produced `#3366FF` as a sixth entry twice and not at all the third time, and
 * it sits 46 away from the permanent-water blue at the edges of permanent water. Everything in
 * this layer is a blue or transparent, so a generous radius cannot pull in an unrelated class.
 */
const GLOFAS_TOLERANCE_SQ = 50 * 50

export type GlofasPixel = 'hazard' | 'permanent-water' | 'none' | 'unreadable'

/** Classifies one pixel of the layer. Exported because what each shade means is the finding here. */
export const classifyGlofasPixel = (r: number, g: number, b: number, a: number): GlofasPixel => {
  if (a < 32) return 'none'

  let best: GlofasPixel = 'unreadable'
  let bestDistance = Number.POSITIVE_INFINITY
  const consider = (entry: { r: number; g: number; b: number }, kind: GlofasPixel) => {
    const distance = (r - entry.r) ** 2 + (g - entry.g) ** 2 + (b - entry.b) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = kind
    }
  }
  for (const blue of GLOFAS_HAZARD_BLUES) consider(blue, 'hazard')
  consider(GLOFAS_PERMANENT_WATER, 'permanent-water')

  return bestDistance <= GLOFAS_TOLERANCE_SQ ? best : 'unreadable'
}

export interface GlofasClassification {
  readonly grid: Array<HazardClass | null>
  readonly hazardPixels: number
  readonly waterPixels: number
  readonly unreadablePixels: number
}

/**
 * The whole raster, as a hazard grid.
 *
 * Permanent water becomes `null` — no zone at all — rather than a class of its own: a lake is not
 * a flood hazard, and drawing one as a hazard zone would put a permanent feature into an answer
 * about what is going to flood.
 */
export const classifyGlofasRaster = (
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): GlofasClassification => {
  const grid: Array<HazardClass | null> = new Array(width * height).fill(null)
  let hazardPixels = 0
  let waterPixels = 0
  let unreadablePixels = 0
  const seen = new Map<number, GlofasPixel>()

  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const r = data[o] ?? 0
    const g = data[o + 1] ?? 0
    const b = data[o + 2] ?? 0
    const a = data[o + 3] ?? 0

    const key = a < 32 ? -1 : (r << 16) | (g << 8) | b
    let kind = seen.get(key)
    if (kind === undefined) {
      kind = classifyGlofasPixel(r, g, b, a)
      seen.set(key, kind)
    }

    if (kind === 'hazard') {
      grid[i] = 'high'
      hazardPixels++
    } else if (kind === 'permanent-water') {
      waterPixels++
    } else if (kind === 'unreadable') {
      grid[i] = 'unclassified'
      unreadablePixels++
    }
  }

  return { grid, hazardPixels, waterPixels, unreadablePixels }
}

/** Pixels per side of the requested map. 512 over a 40 km box is ~78 m, finer than GloFAS's grid. */
const IMAGE_SIZE = 512

/**
 * WMS 1.1.1 with `EPSG:4326`, deliberately.
 *
 * The server advertises 1.3.0 and then fails a 1.3.0 `GetMap` with
 * `cannot unpack non-iterable NoneType object` — an internal error, not a bad request. 1.1.1 works,
 * and its axis order for `EPSG:4326` is the lon/lat one this code already thinks in.
 */
export const glofasMapUrl = (bbox: BBox, size = IMAGE_SIZE): string => {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: LAYER,
    styles: '',
    srs: 'EPSG:4326',
    bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
    width: String(size),
    height: String(size),
    format: 'image/png',
    transparent: 'true',
  })
  return `${OWS_URL}?${params.toString()}`
}

export class GlofasFloodProvider implements FloodDataPort {
  readonly sourceId = 'global.copernicus.glofas'
  readonly meta: ProviderMeta = {
    sourceId: this.sourceId,
    sourceName: 'Copernicus GloFAS — Flood Hazard, 100-year return period',
    docsUrl: 'https://global-flood.emergency.copernicus.eu/',
    vintage: 'GloFAS climatology',
    licence: 'Copernicus Open Access (free reuse with attribution)',
    attribution: 'Copernicus Emergency Management Service — Global Flood Awareness System (GloFAS)',
    // A climatological hazard layer; it changes when the model is rerun, not through the day.
    expectedRefreshMs: 86_400_000 * 365,
  }

  private readonly fetchImpl: typeof fetch
  private readonly decodeTile: TileDecoder

  constructor(fetchImpl?: typeof fetch, decodeTile?: TileDecoder) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.decodeTile = decodeTile ?? decodeWithCanvas
  }

  zonesWithin(query: FloodQuery): Effect.Effect<FloodQueryResult, GeoError> {
    const bbox = createCircleBBox(query.at, query.radiusKm)

    return fetchRasterViaProxy(this.fetchImpl, {
      sourceId: this.sourceId,
      upstreamUrl: glofasMapUrl(bbox),
      signal: query.signal,
    }).pipe(
      Effect.flatMap((response) => {
        if (response.servedFromFixture) {
          return Effect.succeed(this.emptyResult(query, 'fixture'))
        }
        return Effect.tryPromise({
          try: () => this.decodeTile(response.bytes),
          catch: (err) =>
            new SourceUnavailable({
              sourceId: this.sourceId,
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            }),
        }).pipe(
          Effect.map((decoded) =>
            decoded ? this.toResult(decoded, bbox, query) : this.emptyResult(query, 'undecodable'),
          ),
        )
      }),
    )
  }

  private toResult(decoded: DecodedTile, bbox: BBox, query: FloodQuery): FloodQueryResult {
    const provenance: Provenance = {
      sourceId: this.meta.sourceId,
      sourceName: this.meta.sourceName,
      upstreamUrl: `${OWS_URL}?request=GetMap&layers=${LAYER}`,
      datasetVintage: this.meta.vintage,
      retrievedAt: Date.now(),
      cache: { hit: false, ageMs: 0 },
      licence: this.meta.licence,
      attribution: this.meta.attribution,
      mode: 'live',
    }

    const classified = classifyGlofasRaster(decoded.data, decoded.width, decoded.height)
    const depthGrid = new Array<DepthBand | undefined>(classified.grid.length).fill(undefined)

    const zones: Array<FloodZone> = vectoriseTileGrid(
      classified.grid,
      depthGrid,
      decoded.width,
      decoded.height,
      bbox,
      { cellMetres: cellMetresForRadius(query.radiusKm) },
    ).map((zone) => ({
      id: `glofas-100y-${zone.hazardClass}`,
      kind: { kind: 'scenario' as const, designEvent: 'GloFAS 100-year return period' },
      hazardClass: zone.hazardClass,
      depth: undefined,
      geometry: zone.geometry,
      provenance,
    }))

    return {
      zones,
      coverage: this.describeCoverage(zones.length, classified, query.radiusKm),
      staleness: { stale: false },
    }
  }

  private emptyResult(_query: FloodQuery, why: 'fixture' | 'undecodable'): FloodQueryResult {
    return {
      zones: [],
      coverage: {
        state: 'none',
        reason: why === 'fixture' ? 'no_data_for_area' : 'source_failed',
        detail:
          why === 'fixture'
            ? 'GloFAS is a live-only source; fixture mode has no recorded global hazard raster to replay.'
            : 'The GloFAS hazard raster could not be decoded here, so its 100-year extent was not read. This is not a report that the area is outside it.',
        failedSources:
          why === 'fixture' ? [] : [{ sourceId: this.sourceId, error: 'raster could not be decoded' }],
      },
      staleness: { stale: false },
    }
  }

  private describeCoverage(
    zoneCount: number,
    classified: GlofasClassification,
    radiusKm: number,
  ): Coverage {
    const waterNote =
      classified.waterPixels > 0
        ? ' Permanent lakes and river channels here are excluded from the extent rather than reported as hazard.'
        : ''

    if (classified.unreadablePixels > 0) {
      return {
        state: 'partial',
        reason: 'no_data_for_area',
        detail: `Part of the GloFAS raster here is painted in a colour outside the layer's palette and was not read as hazard.${waterNote}`,
        failedSources: [],
      }
    }
    if (zoneCount === 0) {
      return {
        state: 'full',
        detail: `GloFAS maps no 100-year flood hazard within ${radiusKm} km. It is a global model at roughly kilometre scale, so it misses small watercourses a national map would show.${waterNote}`,
        failedSources: [],
      }
    }
    return {
      state: 'full',
      detail: waterNote.trim() === '' ? undefined : waterNote.trim(),
      failedSources: [],
    }
  }
}

/** Exposed for the survey doc and for tests that assert what is actually requested. */
export const GLOFAS_LAYER = LAYER
export const glofasBBoxFor = (at: LonLat, radiusKm: number): BBox => createCircleBBox(at, radiusKm)
