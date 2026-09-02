/**
 * Elevation input for the inundation estimate: Terrarium-encoded DEM tiles
 * (Mapzen/AWS Terrain Tiles) decoded and mosaicked into one working grid.
 */
import type { BBox, LonLat } from '../../domain/geo'
import { createCircleBBox } from '../geometry/circle'
import { lat2tile, lon2tile, tile2lat, tile2lon } from '../geometry/tiles'

export const TILE_SIZE = 256

/**
 * Decodes Terrarium RGB elevation: metres = (R·256 + G + B/256) − 32768.
 * This is the published encoding of the Mapzen/AWS `terrarium` tileset.
 */
export const decodeTerrariumElevations = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array => {
  const pixels = width * height
  if (rgba.length < pixels * 4) {
    throw new RangeError(`RGBA buffer holds ${rgba.length} bytes, needs ${pixels * 4}`)
  }
  const out = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    out[i] = (rgba[o]! * 256 + rgba[o + 1]! + rgba[o + 2]! / 256) - 32768
  }
  return out
}

/**
 * Sentinel the GSI encoding reserves for "no value here": R=128, G=0, B=0, i.e.
 * exactly 2^23, the midpoint of the signed 24-bit range. Kept as NaN through
 * decoding so a void can never be mistaken for sea level — which is what makes
 * it fillable later rather than silently the deepest hole on the map.
 */
const GSI_VOID = 0x800000

/**
 * Decodes GSI's `dem_png` / `dem5a_png` elevation encoding:
 * a signed 24-bit big-endian count of centimetres, x = R·65536 + G·256 + B,
 * with h = x/100 below 2^23, h = (x − 2^24)/100 above it, and 2^23 itself
 * reserved for a void. Void cells decode to NaN.
 *
 * Published at https://maps.gsi.go.jp/development/demtile.html. This is *not*
 * the Terrarium encoding — the two differ in base, sign convention and void
 * handling, so decoding one tileset with the other's reader yields plausible-
 * looking elevations that are wrong by kilometres.
 */
export const decodeGsiDemElevations = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array => {
  const pixels = width * height
  if (rgba.length < pixels * 4) {
    throw new RangeError(`RGBA buffer holds ${rgba.length} bytes, needs ${pixels * 4}`)
  }
  const out = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const raw = (rgba[o]! << 16) | (rgba[o + 1]! << 8) | rgba[o + 2]!
    out[i] = raw === GSI_VOID ? NaN : (raw < GSI_VOID ? raw : raw - 0x1000000) / 100
  }
  return out
}

/**
 * Replaces NaN voids with the nearest measured elevation, and returns how many
 * cells were filled.
 *
 * A void is not a small blemish in these products. GSI's sets carry no value
 * over open water, which is 7% of a 20 km circle at Hitoyoshi and 6% at Mabi —
 * tens of thousands of contiguous cells, not a scattering of pixels. A NaN that
 * survives into the hydrology poisons every comparison it reaches (flow
 * direction, depression filling, stage) *silently*, because NaN compares false
 * against everything: the model returns 0.004 km² of flooding and no error.
 *
 * Nearest-valid, by two-pass chamfer, for two reasons. It is O(cells) whatever
 * the void's size, where relaxing a void inward one ring per sweep is O(cells x
 * void radius) and quietly gives up on anything larger than its pass budget. And
 * it is the right answer at a coastline: the nearest measured ground to a sea
 * void is the shore, which at these sites reads 0 to -3 m, so the sea comes out
 * as a flat shelf at about sea level — an outlet water can leave through, rather
 * than the wall that interpolating from inland neighbours would build.
 *
 * A grid with no valid cell at all cannot be filled; the return count then falls
 * short of the void count, and the caller must treat that as an unusable tile
 * rather than a repaired one.
 */
export const fillElevationVoids = (
  elevations: Float32Array,
  width: number,
  height: number,
): number => {
  let voids = 0
  for (let i = 0; i < elevations.length; i++) if (Number.isNaN(elevations[i]!)) voids++
  if (voids === 0) return 0

  const INF = 1e9
  const dist = new Float32Array(elevations.length)
  const value = Float32Array.from(elevations)
  for (let i = 0; i < elevations.length; i++) dist[i] = Number.isNaN(elevations[i]!) ? INF : 0

  const D1 = 1
  const D2 = Math.SQRT2
  const relax = (at: number, from: number, cost: number): void => {
    const candidate = dist[from]! + cost
    if (candidate < dist[at]!) {
      dist[at] = candidate
      value[at] = value[from]!
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x
      if (y > 0) relax(at, at - width, D1)
      if (x > 0) relax(at, at - 1, D1)
      if (y > 0 && x > 0) relax(at, at - width - 1, D2)
      if (y > 0 && x < width - 1) relax(at, at - width + 1, D2)
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const at = y * width + x
      if (y < height - 1) relax(at, at + width, D1)
      if (x < width - 1) relax(at, at + 1, D1)
      if (y < height - 1 && x < width - 1) relax(at, at + width + 1, D2)
      if (y < height - 1 && x > 0) relax(at, at + width - 1, D2)
    }
  }

  let filled = 0
  for (let i = 0; i < elevations.length; i++) {
    if (!Number.isNaN(elevations[i]!)) continue
    if (dist[i]! >= INF) continue
    elevations[i] = value[i]!
    filled++
  }
  return filled
}

export interface TileRange {
  readonly zoom: number
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly count: number
}

/** The axis-aligned rectangle of slippy tiles covering the query circle. */
export const tileRangeForCircle = (center: LonLat, radiusKm: number, zoom: number): TileRange => {
  const [minLon, minLat, maxLon, maxLat] = createCircleBBox(center, radiusKm)
  const minX = Math.min(lon2tile(minLon, zoom), lon2tile(maxLon, zoom))
  const maxX = Math.max(lon2tile(minLon, zoom), lon2tile(maxLon, zoom))
  const minY = Math.min(lat2tile(maxLat, zoom), lat2tile(minLat, zoom))
  const maxY = Math.max(lat2tile(maxLat, zoom), lat2tile(minLat, zoom))
  return { zoom, minX, maxX, minY, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) }
}

export interface ElevationMosaic {
  readonly zoom: number
  /** Tile coordinates of the mosaic's north-west tile. */
  readonly minTileX: number
  readonly minTileY: number
  readonly width: number
  readonly height: number
  /** Row-major, north to south, west to east. Metres above sea level. */
  readonly elevations: Float32Array
  /** WGS84 bounds of the whole mosaic. */
  readonly bbox: BBox
}

export interface DecodedDemTile {
  readonly x: number
  readonly y: number
  readonly elevations: Float32Array
  readonly width: number
  readonly height: number
}

/**
 * Assembles a rectangular set of decoded tiles into one grid. Every tile of the
 * range must be present and TILE_SIZE² — a hole in the middle of the DEM would
 * silently redirect simulated water, so a missing tile is an error here and the
 * caller decides whether to degrade.
 */
export const buildMosaic = (range: TileRange, tiles: ReadonlyArray<DecodedDemTile>): ElevationMosaic => {
  const tilesX = range.maxX - range.minX + 1
  const tilesY = range.maxY - range.minY + 1
  const width = tilesX * TILE_SIZE
  const height = tilesY * TILE_SIZE
  const elevations = new Float32Array(width * height)
  const seen = new Set<string>()

  for (const tile of tiles) {
    if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE) {
      throw new RangeError(`Tile ${tile.x}/${tile.y} is ${tile.width}×${tile.height}, expected ${TILE_SIZE}²`)
    }
    if (tile.x < range.minX || tile.x > range.maxX || tile.y < range.minY || tile.y > range.maxY) {
      throw new RangeError(`Tile ${tile.x}/${tile.y} lies outside the requested range`)
    }
    const offsetX = (tile.x - range.minX) * TILE_SIZE
    const offsetY = (tile.y - range.minY) * TILE_SIZE
    for (let row = 0; row < TILE_SIZE; row++) {
      elevations.set(
        tile.elevations.subarray(row * TILE_SIZE, (row + 1) * TILE_SIZE),
        (offsetY + row) * width + offsetX,
      )
    }
    seen.add(`${tile.x}/${tile.y}`)
  }

  if (seen.size !== range.count) {
    throw new RangeError(`Mosaic needs ${range.count} tiles, received ${seen.size}`)
  }

  const bbox: BBox = [
    tile2lon(range.minX, range.zoom),
    tile2lat(range.maxY + 1, range.zoom),
    tile2lon(range.maxX + 1, range.zoom),
    tile2lat(range.minY, range.zoom),
  ]
  return {
    zoom: range.zoom,
    minTileX: range.minX,
    minTileY: range.minY,
    width,
    height,
    elevations,
    bbox,
  }
}

/**
 * A cell may sit this far below the median of its neighbours and still be
 * believed. Deeper is a data void, not a landform: a ≥10 m-deep hole one DEM
 * cell (~60 m) wide has no natural analogue at this resolution, while void
 * pixels of −60 to −32768 m are routine in the tile compilation — and every
 * one of them would otherwise become the deepest "flood" on the map.
 */
export const DESPIKE_THRESHOLD_METRES = 10

/**
 * DEM conditioning: replaces cells that fall implausibly far below their
 * surroundings with the second-lowest of their neighbours. Mutates
 * `elevations` in place and returns how many cells were corrected.
 *
 * Second-lowest, not median and not minimum, on purpose: a genuine landform a
 * single cell wide — a gorge floor — always has an along-valley neighbour at
 * its own level, so it passes; an isolated void pixel does not, and a *pair*
 * of adjacent void pixels still heals in one pass because each has only the
 * other below it. Comparisons read the original surface, so scan order does
 * not matter.
 *
 * Border cells are left alone: a valley exiting the domain edge has only one
 * along-valley neighbour there, and "correcting" its last cell would dam the
 * outlet — while a void on the border is harmless, since border cells drain
 * out of the domain regardless of their elevation.
 */
export const despikeElevations = (
  elevations: Float32Array,
  width: number,
  height: number,
  thresholdMetres = DESPIKE_THRESHOLD_METRES,
): number => {
  const original = Float32Array.from(elevations)
  let replaced = 0

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let lowest = Number.POSITIVE_INFINITY
      let secondLowest = Number.POSITIVE_INFINITY
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const value = original[(y + dy) * width + (x + dx)]!
          if (value < lowest) {
            secondLowest = lowest
            lowest = value
          } else if (value < secondLowest) {
            secondLowest = value
          }
        }
      }
      const i = y * width + x
      if (original[i]! < secondLowest - thresholdMetres) {
        elevations[i] = secondLowest
        replaced++
      }
    }
  }
  return replaced
}

const METRES_PER_DEGREE = 111_320

export interface MosaicGeometry {
  /** Centre latitude of each pixel row, exact inverse-Mercator, north to south. */
  readonly rowLatitudes: Float64Array
  /** Ground area of one cell in each row, m². Varies with latitude. */
  readonly rowCellAreaM2: Float64Array
  /** Ground width/height of a cell in each row, metres. */
  readonly rowCellWidthM: Float64Array
  readonly rowCellHeightM: Float64Array
}

/**
 * Per-row ground geometry of the mosaic. Web Mercator pixels are uniform in
 * projected space, not on the ground, and volume bookkeeping in the spread
 * model is only conservative if each row's true cell area is used.
 */
export const mosaicGeometry = (mosaic: ElevationMosaic): MosaicGeometry => {
  const rowLatitudes = new Float64Array(mosaic.height)
  const rowCellAreaM2 = new Float64Array(mosaic.height)
  const rowCellWidthM = new Float64Array(mosaic.height)
  const rowCellHeightM = new Float64Array(mosaic.height)

  for (let row = 0; row < mosaic.height; row++) {
    const yTop = mosaic.minTileY + row / TILE_SIZE
    const yBottom = mosaic.minTileY + (row + 1) / TILE_SIZE
    const latTop = tile2lat(yTop, mosaic.zoom)
    const latBottom = tile2lat(yBottom, mosaic.zoom)
    const latCentre = (latTop + latBottom) / 2

    const cellHeightM = (latTop - latBottom) * METRES_PER_DEGREE
    const lonSpanDeg = 360 / (2 ** mosaic.zoom * TILE_SIZE)
    const cellWidthM = lonSpanDeg * METRES_PER_DEGREE * Math.cos((latCentre * Math.PI) / 180)

    rowLatitudes[row] = latCentre
    rowCellWidthM[row] = cellWidthM
    rowCellHeightM[row] = cellHeightM
    rowCellAreaM2[row] = cellWidthM * cellHeightM
  }

  return { rowLatitudes, rowCellAreaM2, rowCellWidthM, rowCellHeightM }
}

/** Centre longitude of a mosaic column. */
export const columnLongitude = (mosaic: ElevationMosaic, col: number): number =>
  tile2lon(mosaic.minTileX + (col + 0.5) / TILE_SIZE, mosaic.zoom)
