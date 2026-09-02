/**
 * The two physical inputs every flood model here needs: terrain and rain.
 *
 * Shared by `/api/geo/inundation-estimate` (pluvial) and `/api/geo/flood-model`
 * (coupled pluvial-fluvial) so the two endpoints cannot drift into disagreeing
 * about where the ground is or how much it rained.
 */
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PNG } from 'pngjs'
import type { LonLat } from '../src/domain/geo'
import {
  TILE_SIZE,
  buildMosaic,
  decodeGsiDemElevations,
  decodeTerrariumElevations,
  despikeElevations,
  fillElevationVoids,
  tileRangeForCircle,
  type DecodedDemTile,
  type ElevationMosaic,
  type TileRange,
} from '../src/lib/hydrology/terrain'
import type { ServerConfig } from './config'
import type { GeoProxyService } from './geo-proxy'
import { BoundedCache } from './static-cache'

export const DEM_SOURCE_ID = 'global.aws.terrarium'
export const DEM_ATTRIBUTION =
  'Terrain Tiles by Mapzen/AWS Open Data (SRTM, NED, GMTED and others); ODbL and public-domain sources'
export const demTileUrl = (z: number, x: number, y: number): string =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

/**
 * Which elevation tileset the terrain is read from.
 *
 * The global default is SRTM-derived at ~60-75 m with metres of vertical error,
 * which is the constraint every round of accuracy work since round eight has
 * ended up pointing at: on a floodplain with metres of total relief, a DEM whose
 * noise is the same size as the landform cannot discriminate wet from dry. The
 * GSI sets are Japan's national survey — 10 m photogrammetry and 5 m airborne
 * LiDAR — and exist here so that claim can be measured instead of asserted.
 *
 * `gsi5` is LiDAR and is void over open water and outside the surveyed strip
 * (10% of a floodplain tile at Joso); those voids are filled from the
 * neighbourhood on load. `gsi10` has no voids at any of the hindcast sites.
 */
export type DemSource = 'terrarium' | 'gsi10' | 'gsi5'

export interface DemSourceSpec {
  readonly id: string
  readonly attribution: string
  readonly url: (z: number, x: number, y: number) => string
  readonly decode: (rgba: Uint8Array, width: number, height: number) => Float32Array
  /** Deepest zoom the publisher actually serves; asking past it returns 404s. */
  readonly maxZoom: number
  /** Zoom the source is read at when nothing else constrains the choice. */
  readonly startZoom: number
}

export const DEM_SOURCES: Readonly<Record<DemSource, DemSourceSpec>> = {
  terrarium: {
    id: DEM_SOURCE_ID,
    attribution: DEM_ATTRIBUTION,
    url: demTileUrl,
    decode: decodeTerrariumElevations,
    maxZoom: 15,
    startZoom: 11,
  },
  gsi10: {
    id: 'jp.gsi.dem10b',
    attribution: '国土地理院 DEM10B elevation tiles (Geospatial Information Authority of Japan)',
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
    decode: decodeGsiDemElevations,
    maxZoom: 14,
    startZoom: 14,
  },
  gsi5: {
    id: 'jp.gsi.dem5a',
    attribution: '国土地理院 DEM5A LiDAR elevation tiles (Geospatial Information Authority of Japan)',
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`,
    decode: decodeGsiDemElevations,
    maxZoom: 15,
    startZoom: 15,
  },
}

export const isDemSource = (value: unknown): value is DemSource =>
  typeof value === 'string' && Object.hasOwn(DEM_SOURCES, value)

/** Conventional location of the DEM store, for tools that fill it. Off unless configured. */
export const DEFAULT_DEM_CACHE_DIR = join('.cache', 'dem')

export const demTilePath = (
  cacheDir: string,
  source: DemSource,
  z: number,
  x: number,
  y: number,
): string => join(cacheDir, source, String(z), String(x), `${y}.png`)

export const PRECIP_SOURCE_ID = 'global.open-meteo.forecast'

export const DEFAULT_RADIUS_KM = 20
export const MAX_RADIUS_KM = 20
export const DEFAULT_DURATION_HOURS = 24
export const MAX_DURATION_HOURS = 72
export const MAX_DESIGN_STORM_MM = 2000

/**
 * z11 DEM pixels are ~60-75 m at mid-latitudes: fine enough to resolve the
 * depressions a 20 km screening question cares about, coarse enough that the
 * full-circle grid stays near one million cells.
 */
export const DEM_ZOOM = 11
export const MIN_DEM_ZOOM = 8
/** 64 tiles of 256^2 cells - the grid the spreading model is budgeted for. */
export const MAX_GRID_CELLS = 64 * TILE_SIZE * TILE_SIZE

export const badRequest = (field: string, message: string) => ({
  error: 'ValidationError',
  fields: [{ field, message }],
})

export const numberInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/**
 * The DEM grid must fit the model's budget; the radius wins and the resolution
 * degrades, never the other way around.
 */
export const chooseDemZoom = (
  at: LonLat,
  radiusKm: number,
  config: ServerConfig,
  startZoom = DEM_ZOOM,
): { zoom: number; range: TileRange } => {
  let zoom = startZoom
  let range = tileRangeForCircle(at, radiusKm, zoom)
  while (
    zoom > MIN_DEM_ZOOM &&
    (range.count > config.geoTileCap || range.count * TILE_SIZE * TILE_SIZE > MAX_GRID_CELLS)
  ) {
    zoom -= 1
    range = tileRangeForCircle(at, radiusKm, zoom)
  }
  return { zoom, range }
}

const decodeDemPng = (bytes: Uint8Array): { data: Uint8Array; width: number; height: number } => {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  return {
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  }
}

/**
 * A deterministic basin for fixture mode, so the whole pipeline runs offline: a
 * bowl dipping toward the query point, ripples that create secondary
 * depressions, and rising ground toward the mosaic edges.
 */
export const syntheticMosaic = (range: TileRange, at: LonLat): ElevationMosaic => {
  const tiles: Array<DecodedDemTile> = []
  const tilesX = range.maxX - range.minX + 1
  const tilesY = range.maxY - range.minY + 1
  const width = tilesX * TILE_SIZE
  const height = tilesY * TILE_SIZE

  // Fractional slippy coordinates of the query point, so the bowl bottom lands
  // inside the query circle no matter where the tile rectangle was cut.
  const n = 2 ** range.zoom
  const xFrac = ((at.longitude + 180) / 360) * n
  const latRad = (at.latitude * Math.PI) / 180
  const yFrac = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n
  const u0 = Math.min(1, Math.max(0, (xFrac - range.minX) / tilesX))
  const v0 = Math.min(1, Math.max(0, (yFrac - range.minY) / tilesY))

  for (let ty = range.minY; ty <= range.maxY; ty++) {
    for (let tx = range.minX; tx <= range.maxX; tx++) {
      const elevations = new Float32Array(TILE_SIZE * TILE_SIZE)
      for (let row = 0; row < TILE_SIZE; row++) {
        const v = ((ty - range.minY) * TILE_SIZE + row) / height
        for (let col = 0; col < TILE_SIZE; col++) {
          const u = ((tx - range.minX) * TILE_SIZE + col) / width
          const bowl = 400 * ((u - u0) ** 2 + (v - v0) ** 2)
          const ripple = 1.5 * Math.sin(u * 40) * Math.sin(v * 40)
          elevations[row * TILE_SIZE + col] = 25 + bowl + ripple
        }
      }
      tiles.push({ x: tx, y: ty, width: TILE_SIZE, height: TILE_SIZE, elevations })
    }
  }
  return buildMosaic(range, tiles)
}

/**
 * Decoded DEM tiles, keyed by slippy coordinate.
 *
 * The terrain under a query never changes, so refetching and re-decoding it for
 * every storm was the single largest cost in a repeat request. A 256² tile of
 * Float32 elevations is 256 KB, so this caps out around 64 MB.
 *
 * Safe to share because `buildMosaic` copies each tile into the mosaic it
 * returns; the conditioning steps that follow — despiking, breaching — mutate
 * that copy and never the cached original.
 */
const demTileCache = new BoundedCache<Float32Array>({ maxEntries: 256 })

export const demCacheStats = () => demTileCache.stats

export interface LoadedTerrain {
  readonly mosaic: ElevationMosaic
  readonly cellsDespiked: number
  /** Void cells repaired from their neighbourhood; always 0 for a void-free source. */
  readonly cellsVoidFilled: number
  readonly source: DemSource
}

/**
 * Reads one tile's PNG bytes, preferring the on-disk store. Elevation tiles never
 * change, so a hit here is always as good as a fetch and costs no upstream call.
 */
const tileBytes = async (
  proxy: GeoProxyService,
  spec: DemSourceSpec,
  source: DemSource,
  z: number,
  x: number,
  y: number,
  cacheDir: string,
): Promise<Uint8Array> => {
  const path = cacheDir ? demTilePath(cacheDir, source, z, x, y) : ''
  if (path && existsSync(path)) return new Uint8Array(await readFile(path))

  const res = await proxy.fetchUpstreamBinary(spec.id, spec.url(z, x, y))
  if (res.status !== 200) {
    throw new Error(`UpstreamFailed: DEM tile ${source} ${z}/${x}/${y} answered ${res.status}`)
  }
  if (path) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, res.bytes)
  }
  return res.bytes
}

/**
 * Fetches and conditions the DEM for a tile range. Voids are repaired first —
 * NaN from a GSI void, then cells far below their neighbourhood — because a
 * single -122 m void otherwise becomes the deepest pond on the map.
 */
export const loadTerrain = async (
  proxy: GeoProxyService,
  range: TileRange,
  at: LonLat,
  fixtureMode: boolean,
  options: { source?: DemSource; cacheDir?: string } = {},
): Promise<LoadedTerrain> => {
  const source = options.source ?? 'terrarium'
  const cacheDir = options.cacheDir ?? ''
  if (fixtureMode) {
    return { mosaic: syntheticMosaic(range, at), cellsDespiked: 0, cellsVoidFilled: 0, source }
  }

  const spec = DEM_SOURCES[source]
  const tilesX = range.maxX - range.minX + 1
  const decoded = await Promise.all(
    Array.from({ length: range.count }, async (_, i): Promise<DecodedDemTile> => {
      const x = range.minX + (i % tilesX)
      const y = range.minY + Math.floor(i / tilesX)
      const key = `${source}/${range.zoom}/${x}/${y}`

      const cached = demTileCache.get(key)
      if (cached !== undefined) {
        return { x, y, width: TILE_SIZE, height: TILE_SIZE, elevations: cached }
      }

      const bytes = await tileBytes(proxy, spec, source, range.zoom, x, y, cacheDir)
      const png = decodeDemPng(bytes)
      const elevations = spec.decode(png.data, png.width, png.height)
      if (png.width === TILE_SIZE && png.height === TILE_SIZE) demTileCache.set(key, elevations)
      return { x, y, width: png.width, height: png.height, elevations }
    }),
  )
  const mosaic = buildMosaic(range, decoded)
  const cellsVoidFilled = fillElevationVoids(mosaic.elevations, mosaic.width, mosaic.height)
  const cellsDespiked = despikeElevations(mosaic.elevations, mosaic.width, mosaic.height)
  return { mosaic, cellsDespiked, cellsVoidFilled, source }
}

/** Where forecast rainfall is sampled: the centre and four points at 0.6·R. */
const sampleLocations = (at: LonLat, radiusKm: number): ReadonlyArray<LonLat> => {
  const dLat = (radiusKm * 0.6) / 111.32
  const dLon = dLat / Math.max(0.2, Math.cos((at.latitude * Math.PI) / 180))
  return [
    at,
    { latitude: at.latitude + dLat, longitude: at.longitude },
    { latitude: at.latitude - dLat, longitude: at.longitude },
    { latitude: at.latitude, longitude: at.longitude + dLon },
    { latitude: at.latitude, longitude: at.longitude - dLon },
  ]
}

export const openMeteoUrl = (samples: ReadonlyArray<LonLat>, durationHours: number): string => {
  const params = new URLSearchParams({
    latitude: samples.map((s) => s.latitude.toFixed(4)).join(','),
    longitude: samples.map((s) => s.longitude.toFixed(4)).join(','),
    hourly: 'precipitation',
    forecast_hours: String(durationHours),
    timezone: 'UTC',
  })
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`
}

interface OpenMeteoLocation {
  readonly hourly?: { readonly precipitation?: ReadonlyArray<number | null> }
}

/** Accumulated rainfall per sample point, averaged across the circle. */
export const parseOpenMeteoRainfall = (
  body: string,
): { meanMm: number; minMm: number; maxMm: number; samples: number } | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const locations: ReadonlyArray<OpenMeteoLocation> = Array.isArray(parsed)
    ? (parsed as ReadonlyArray<OpenMeteoLocation>)
    : [parsed as OpenMeteoLocation]

  const totals: number[] = []
  for (const location of locations) {
    const hourly = location?.hourly?.precipitation
    if (!Array.isArray(hourly)) continue
    let sum = 0
    for (const value of hourly) {
      if (typeof value === 'number' && Number.isFinite(value)) sum += value
    }
    totals.push(sum)
  }
  if (totals.length === 0) return null

  const meanMm = totals.reduce((a, b) => a + b, 0) / totals.length
  return {
    meanMm: Math.round(meanMm * 100) / 100,
    minMm: Math.round(Math.min(...totals) * 100) / 100,
    maxMm: Math.round(Math.max(...totals) * 100) / 100,
    samples: totals.length,
  }
}

export class PrecipitationUnavailable extends Error {}

export interface ResolvedPrecipitation {
  readonly rainfallMm: number
  readonly detail: Record<string, unknown>
}

/**
 * The event rainfall the model will use: a caller-supplied design storm if
 * there is one, otherwise the accumulated forecast. Throws
 * `PrecipitationUnavailable` rather than guessing when the feed is unreadable —
 * a silently assumed storm is the one number no flood model should invent.
 */
export const resolvePrecipitation = async (
  proxy: GeoProxyService,
  at: LonLat,
  radiusKm: number,
  durationHours: number,
  designStormMm: number | undefined,
  fixtureMode: boolean,
): Promise<ResolvedPrecipitation> => {
  if (designStormMm !== undefined) {
    return {
      rainfallMm: designStormMm,
      detail: {
        rainfallMm: designStormMm,
        durationHours,
        source: 'design-storm',
        detail: 'Caller-supplied event rainfall; no forecast was fetched.',
      },
    }
  }
  if (fixtureMode) {
    return {
      rainfallMm: 100,
      detail: {
        rainfallMm: 100,
        durationHours,
        source: 'fixture',
        detail: 'Fixture mode default of 100 mm; pass rainfallMm to vary it.',
      },
    }
  }

  const url = openMeteoUrl(sampleLocations(at, radiusKm), durationHours)
  const res = await proxy.fetchUpstream(PRECIP_SOURCE_ID, url)
  const parsed = res.status === 200 ? parseOpenMeteoRainfall(res.body) : null
  if (parsed === null) {
    throw new PrecipitationUnavailable(
      `Open-Meteo precipitation was unreadable (status ${res.status}); pass rainfallMm to run a design storm instead.`,
    )
  }
  return {
    rainfallMm: parsed.meanMm,
    detail: {
      rainfallMm: parsed.meanMm,
      durationHours,
      source: PRECIP_SOURCE_ID,
      detail: `Mean of ${parsed.samples} forecast points over the next ${durationHours} h (min ${parsed.minMm} mm, max ${parsed.maxMm} mm).`,
      rangeAcrossAreaMm: { min: parsed.minMm, max: parsed.maxMm },
    },
  }
}
