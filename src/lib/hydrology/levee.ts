/**
 * Flood defences: embankments as barriers to inundation.
 *
 * Validation against five Japanese flood disasters showed the model's worst
 * error was flooding land that is defended — at Joso it inundated the Tone and
 * Kokai floodplains, which held in 2015 because they are leveed. No DEM at
 * 30–90 m carries an embankment: a levee is a few metres high and a few metres
 * wide, far below a cell. So the barriers have to come from somewhere else and
 * be imposed on the result.
 *
 * Two steps. Embankment lines are burned onto the model grid as a crest
 * elevation, and then the river's inundation is restricted to what it can
 * actually reach: a flood fill outward from the channel that cannot cross a
 * crest standing above the water surface. Land behind an un-overtopped
 * embankment comes out dry, which is the whole point.
 *
 * This is also what finally gives a levee breach something to do — a breach
 * opens a gap in the barrier, and the water goes through it.
 */
import type { ElevationMosaic, MosaicGeometry } from './terrain'
import { TILE_SIZE, columnLongitude } from './terrain'

export interface LeveeSegment {
  /** Ordered [longitude, latitude] vertices of one embankment way. */
  readonly points: ReadonlyArray<readonly [number, number]>
  /** Crest height above local ground, metres, where the source records one. */
  readonly heightM?: number
}

/**
 * Typical crest height of a river embankment above the ground it protects.
 *
 * Sources almost never record it — OSM has geometry but rarely a height — so a
 * default is unavoidable. Japanese class-A river levees commonly stand 3–8 m
 * above the floodplain; 5 m sits in the middle of that and is exposed as a
 * parameter rather than buried.
 */
export const DEFAULT_LEVEE_HEIGHT_M = 5

export interface RasterisedLevees {
  /** Crest elevation per cell, or -Infinity where there is no embankment. */
  readonly crestM: Float32Array
  readonly leveeCells: number
  readonly segmentsBurned: number
}

/** Grid cell containing a coordinate, or -1 outside the mosaic. */
const cellAt = (mosaic: ElevationMosaic, lon: number, lat: number): number => {
  const n = 2 ** mosaic.zoom
  const xf = ((lon + 180) / 360) * n
  const yf = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n
  const col = Math.floor((xf - mosaic.minTileX) * TILE_SIZE)
  const row = Math.floor((yf - mosaic.minTileY) * TILE_SIZE)
  if (col < 0 || col >= mosaic.width || row < 0 || row >= mosaic.height) return -1
  return row * mosaic.width + col
}

const colRowAt = (mosaic: ElevationMosaic, lon: number, lat: number): [number, number] => {
  const n = 2 ** mosaic.zoom
  const xf = ((lon + 180) / 360) * n
  const yf = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n
  // floor, not round: a coordinate belongs to the cell that contains it, and
  // rounding would shift a cell-centre coordinate into its neighbour.
  return [
    Math.floor((xf - mosaic.minTileX) * TILE_SIZE),
    Math.floor((yf - mosaic.minTileY) * TILE_SIZE),
  ]
}

/**
 * Burns embankment lines onto the grid as crest elevations.
 *
 * The crest is taken as the ground the DEM already has plus the embankment's
 * height, so a levee on high ground is high and one on the floodplain is low —
 * which is how they are built. Where two embankments cross a cell the higher
 * crest wins.
 */
export const rasteriseLevees = (
  segments: ReadonlyArray<LeveeSegment>,
  mosaic: ElevationMosaic,
  defaultHeightM = DEFAULT_LEVEE_HEIGHT_M,
): RasterisedLevees => {
  const n = mosaic.width * mosaic.height
  const crestM = new Float32Array(n).fill(Number.NEGATIVE_INFINITY)
  let leveeCells = 0
  let segmentsBurned = 0

  const mark = (cell: number, height: number): void => {
    if (cell < 0) return
    const crest = mosaic.elevations[cell]! + height
    if (crestM[cell] === Number.NEGATIVE_INFINITY) leveeCells++
    if (crest > crestM[cell]!) crestM[cell] = crest
  }

  for (const segment of segments) {
    const height = segment.heightM ?? defaultHeightM
    let burned = false
    for (let i = 0; i + 1 < segment.points.length; i++) {
      const [lon0, lat0] = segment.points[i]!
      const [lon1, lat1] = segment.points[i + 1]!
      let [x0, y0] = colRowAt(mosaic, lon0, lat0)
      const [x1, y1] = colRowAt(mosaic, lon1, lat1)

      // Bresenham, so a line never leaves a diagonal gap water could slip through.
      const dx = Math.abs(x1 - x0)
      const dy = -Math.abs(y1 - y0)
      const sx = x0 < x1 ? 1 : -1
      const sy = y0 < y1 ? 1 : -1
      let err = dx + dy
      // A single way can be long; cap the walk so a corrupt coordinate cannot spin.
      for (let guard = 0; guard < 100_000; guard++) {
        if (x0 >= 0 && x0 < mosaic.width && y0 >= 0 && y0 < mosaic.height) {
          mark(y0 * mosaic.width + x0, height)
          burned = true
        }
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 >= dy) {
          err += dy
          x0 += sx
        }
        if (e2 <= dx) {
          err += dx
          y0 += sy
        }
      }
    }
    if (burned) segmentsBurned++
  }

  return { crestM, leveeCells, segmentsBurned }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
]

export interface LeveeProtectionInput {
  /** Fluvial depth field to restrict. Not mutated. */
  readonly depths: Float32Array
  /** Stage per channel cell, metres above the river. */
  readonly stageM: Float64Array
  readonly nearestChannel: Int32Array
  readonly isChannel: Uint8Array
  readonly elevations: Float32Array
  readonly crestM: Float32Array
  /** Cells where the embankment has failed and water may pass. */
  readonly breachOpen?: Uint8Array
  readonly width: number
  readonly height: number
}

export interface LeveeProtectionResult {
  readonly depths: Float32Array
  /** Cells the river could not reach because a defence held. */
  readonly protectedCells: number
  /** Cells that stayed wet. */
  readonly reachedCells: number
}

/**
 * Restricts river inundation to what the water can actually reach.
 *
 * A flood fill runs outward from the wet channel. It may enter a cell only if
 * that cell would be wet on the unrestricted field and no embankment crest
 * there stands above the water surface — unless the embankment has been
 * breached, in which case water passes.
 *
 * The water surface is flat across everything draining to one reach: a cell's
 * depth is `stage − HAND` and its HAND is measured from that reach, so the
 * surface elevation is the reach's bed plus its stage, wherever you stand.
 */
export const applyLeveeProtection = (input: LeveeProtectionInput): LeveeProtectionResult => {
  const {
    depths, stageM, nearestChannel, isChannel, elevations, crestM, breachOpen, width, height,
  } = input
  const n = width * height
  const out = new Float32Array(n)
  const reached = new Uint8Array(n)
  const queue: number[] = []

  const waterSurfaceAt = (cell: number): number => {
    const reach = nearestChannel[cell]!
    if (reach < 0) return Number.NEGATIVE_INFINITY
    return elevations[reach]! + stageM[reach]!
  }

  // Seed from the river itself: wherever there is water in a channel.
  for (let c = 0; c < n; c++) {
    if (!isChannel[c] || !(depths[c]! > 0)) continue
    reached[c] = 1
    out[c] = depths[c]!
    queue.push(c)
  }

  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!
    const cx = c % width
    const cy = (c - cx) / width
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const ni = ny * width + nx
      if (reached[ni] || !(depths[ni]! > 0)) continue

      const crest = crestM[ni]!
      const defended = crest !== Number.NEGATIVE_INFINITY && !(breachOpen && breachOpen[ni])
      if (defended && crest > waterSurfaceAt(ni)) continue

      reached[ni] = 1
      out[ni] = depths[ni]!
      queue.push(ni)
    }
  }

  let protectedCells = 0
  let reachedCells = 0
  for (let i = 0; i < n; i++) {
    if (depths[i]! > 0 && !reached[i]) protectedCells++
    if (reached[i]) reachedCells++
  }

  return { depths: out, protectedCells, reachedCells }
}

/** Marks cells within `radiusCells` of each breach as an opening in the defence. */
export const openBreaches = (
  breachCells: ReadonlyArray<number>,
  width: number,
  height: number,
  radiusCells: number,
): Uint8Array => {
  const open = new Uint8Array(width * height)
  for (const cell of breachCells) {
    const cx = cell % width
    const cy = Math.floor(cell / width)
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        if (Math.hypot(dx, dy) > radiusCells) continue
        open[ny * width + nx] = 1
      }
    }
  }
  return open
}

/** Longitude/latitude of a grid cell — used to report where defences were found. */
export const cellCentre = (
  mosaic: ElevationMosaic,
  geometry: MosaicGeometry,
  cell: number,
): { longitude: number; latitude: number } => ({
  longitude: columnLongitude(mosaic, cell % mosaic.width),
  latitude: geometry.rowLatitudes[Math.floor(cell / mosaic.width)]!,
})

export { cellAt as leveeCellAt }
