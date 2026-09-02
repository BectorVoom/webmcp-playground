/**
 * Permanent water: the lakes, reservoirs and river channels that are wet on a
 * dry day.
 *
 * A screening model built from terrain has no way to tell standing water from
 * ground, and both of its mechanisms are drawn to it. A lake basin is a closed
 * depression, so fill-and-spill ponds rain in it and steady state never drains
 * it; the same basin also carries the drainage network, so the river stage
 * covers it too. The result is a model that reports Lake Nojiri as 2 km² of
 * flood — measured at 15-33% of the false-positive area at every hindcast site,
 * and 68.5% of the error more than 3 km from any designated flood zone.
 *
 * `src/adapters/geo/glofas-flood.ts` already draws this distinction for the
 * European forecast raster, where permanent water has its own shade: "Real
 * water, but not a flood forecast about it." This is the same rule applied to
 * the model's own output.
 *
 * **Masking removes the normal pool, not the hazard.** A cell is only dropped
 * if it is already permanently wet, so flooding beyond a shoreline is untouched
 * and the reported extent still ends where the water stops being ordinary. The
 * water body itself does not become safe by being left off a flood map — it was
 * never land that floods, which is exactly why an official hazard map excludes
 * it and why reporting it as inundation is noise rather than warning.
 */
import type { ElevationMosaic } from './terrain'
import { TILE_SIZE } from './terrain'

/**
 * One mapped body of standing water. The first ring is the outer boundary and
 * any others are holes — an island in a lake is not water — which the even-odd
 * fill below handles without needing to know which is which.
 */
export interface WaterBody {
  readonly rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>
}

export interface RasterisedWater {
  /** 1 where the cell centre falls inside a mapped water body. */
  readonly isWater: Uint8Array
  readonly waterCells: number
  /** Bodies that put at least one cell on the grid; the rest fell outside or under a cell. */
  readonly bodiesBurned: number
}

/** Fractional mosaic pixel coordinates. Linear in longitude, monotonic in latitude. */
const toPixel = (
  mosaic: ElevationMosaic,
  lon: number,
  lat: number,
): readonly [number, number] => {
  const n = 2 ** mosaic.zoom
  const xf = ((lon + 180) / 360) * n
  const yf = (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2 * n
  return [(xf - mosaic.minTileX) * TILE_SIZE, (yf - mosaic.minTileY) * TILE_SIZE]
}

/**
 * Burns water bodies onto the model grid by scanline fill.
 *
 * The fill runs in mosaic pixel space rather than in degrees: Web Mercator
 * pixel coordinates are linear in longitude and monotonic in latitude, so a
 * horizontal scanline there is a line of constant latitude and the crossing
 * arithmetic is exact. Doing it in degrees would need a projection per row.
 *
 * Even-odd within a body, union across bodies: two lakes cannot cancel each
 * other out, but a ring inside a ring is an island.
 */
export const rasteriseWaterBodies = (
  bodies: ReadonlyArray<WaterBody>,
  mosaic: ElevationMosaic,
): RasterisedWater => {
  const { width, height } = mosaic
  const isWater = new Uint8Array(width * height)
  let waterCells = 0
  let bodiesBurned = 0

  for (const body of bodies) {
    const rings = body.rings
      .filter((ring) => ring.length >= 3)
      .map((ring) => ring.map(([lon, lat]) => toPixel(mosaic, lon, lat)))
    if (rings.length === 0) continue

    let minY = Infinity
    let maxY = -Infinity
    for (const ring of rings) {
      for (const [, y] of ring) {
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const firstRow = Math.max(0, Math.floor(minY))
    const lastRow = Math.min(height - 1, Math.ceil(maxY))
    let burned = false

    for (let row = firstRow; row <= lastRow; row++) {
      const scanY = row + 0.5
      const crossings: Array<number> = []
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          // Implicitly closed: the last vertex joins the first.
          const [x0, y0] = ring[i]!
          const [x1, y1] = ring[(i + 1) % ring.length]!
          if (y0 === y1) continue
          if (y0 <= scanY === y1 <= scanY) continue
          crossings.push(x0 + ((scanY - y0) / (y1 - y0)) * (x1 - x0))
        }
      }
      if (crossings.length < 2) continue
      crossings.sort((a, b) => a - b)

      for (let i = 0; i + 1 < crossings.length; i += 2) {
        // A cell is inside when its centre is, so the span runs between the
        // columns whose centres the crossings bracket.
        const from = Math.max(0, Math.ceil(crossings[i]! - 0.5))
        const to = Math.min(width - 1, Math.floor(crossings[i + 1]! - 0.5))
        for (let col = from; col <= to; col++) {
          const cell = row * width + col
          if (isWater[cell] === 1) continue
          isWater[cell] = 1
          waterCells++
          burned = true
        }
      }
    }
    if (burned) bodiesBurned++
  }

  return { isWater, waterCells, bodiesBurned }
}

export interface WaterMaskResult {
  /** A copy of `depths` with permanently wet cells set dry. */
  readonly depths: Float32Array
  /** Cells that were reported as flooded and are simply water. */
  readonly maskedCells: number
  readonly maskedAreaM2: number
}

/**
 * Drops permanently wet cells from a reported depth field.
 *
 * Never mutates the input: the unmasked field is what the attribution figures
 * are computed against, and a caller that wants both must be able to have both.
 */
export const maskPermanentWater = (
  depths: Float32Array,
  isWater: Uint8Array,
  rowCellAreaM2: Float64Array,
  width: number,
): WaterMaskResult => {
  const masked = Float32Array.from(depths)
  let maskedCells = 0
  let maskedAreaM2 = 0
  for (let cell = 0; cell < masked.length; cell++) {
    if (isWater[cell] !== 1 || masked[cell]! <= 0) continue
    masked[cell] = 0
    maskedCells++
    maskedAreaM2 += rowCellAreaM2[Math.floor(cell / width)] ?? 0
  }
  return { depths: masked, maskedCells, maskedAreaM2 }
}
