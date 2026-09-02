import { describe, expect, it } from 'vitest'
import { applyLeveeProtection, openBreaches, rasteriseLevees } from './levee'
import { buildMosaic, TILE_SIZE, type DecodedDemTile, type ElevationMosaic } from './terrain'

/** A one-tile mosaic at a known place, with caller-supplied ground. */
const mosaicWith = (fill: (row: number, col: number) => number): ElevationMosaic => {
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE)
  for (let row = 0; row < TILE_SIZE; row++) {
    for (let col = 0; col < TILE_SIZE; col++) elevations[row * TILE_SIZE + col] = fill(row, col)
  }
  const tile: DecodedDemTile = { x: 1817, y: 806, width: TILE_SIZE, height: TILE_SIZE, elevations }
  return buildMosaic({ zoom: 11, minX: 1817, maxX: 1817, minY: 806, maxY: 806, count: 1 }, [tile])
}

/** Longitude/latitude of a cell centre, for building test geometry. */
const centreOf = (mosaic: ElevationMosaic, row: number, col: number): [number, number] => {
  const n = 2 ** mosaic.zoom
  const lon = ((mosaic.minTileX + (col + 0.5) / TILE_SIZE) / n) * 360 - 180
  const yf = mosaic.minTileY + (row + 0.5) / TILE_SIZE
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yf) / n))) * 180) / Math.PI
  return [lon, lat]
}

describe('rasterising embankments', () => {
  it('burns a continuous line with no diagonal gaps', () => {
    const mosaic = mosaicWith(() => 10)
    // A diagonal way across a few cells: Bresenham must leave no hole.
    const points = [centreOf(mosaic, 10, 10), centreOf(mosaic, 20, 20)]
    const { crestM, leveeCells, segmentsBurned } = rasteriseLevees([{ points }], mosaic, 5)

    expect(segmentsBurned).toBe(1)
    expect(leveeCells).toBeGreaterThanOrEqual(10)
    // Crest is ground plus height.
    expect(crestM[10 * mosaic.width + 10]).toBeCloseTo(15, 4)
    // Every step of the diagonal is marked.
    for (let k = 0; k <= 10; k++) {
      expect(crestM[(10 + k) * mosaic.width + (10 + k)]).toBeGreaterThan(Number.NEGATIVE_INFINITY)
    }
  })

  it('sits the crest on the ground it is built on', () => {
    const mosaic = mosaicWith((row) => (row < 100 ? 5 : 50))
    const low = [centreOf(mosaic, 50, 10), centreOf(mosaic, 50, 20)]
    const high = [centreOf(mosaic, 150, 10), centreOf(mosaic, 150, 20)]
    const { crestM } = rasteriseLevees([{ points: low }, { points: high }], mosaic, 4)
    expect(crestM[50 * mosaic.width + 15]).toBeCloseTo(9, 4)
    expect(crestM[150 * mosaic.width + 15]).toBeCloseTo(54, 4)
  })

  it('prefers a recorded height over the default, and keeps the higher of two crossing ways', () => {
    const mosaic = mosaicWith(() => 0)
    const line = [centreOf(mosaic, 30, 5), centreOf(mosaic, 30, 40)]
    expect(rasteriseLevees([{ points: line, heightM: 9 }], mosaic, 3).crestM[30 * mosaic.width + 20])
      .toBeCloseTo(9, 4)
    const both = rasteriseLevees([{ points: line, heightM: 2 }, { points: line, heightM: 7 }], mosaic, 3)
    expect(both.crestM[30 * mosaic.width + 20]).toBeCloseTo(7, 4)
  })

  it('leaves the grid untouched when there is nothing mapped', () => {
    const mosaic = mosaicWith(() => 10)
    const { crestM, leveeCells } = rasteriseLevees([], mosaic, 5)
    expect(leveeCells).toBe(0)
    for (const v of crestM) expect(v).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('levee protection of river inundation', () => {
  /**
   * A 1-D transect: the river at column 0, flat floodplain rising away from it,
   * with an embankment standing at column 20.
   */
  const scene = (leveeHeightM: number, stage: number) => {
    const width = 60
    const height = 3
    const n = width * height
    const elevations = new Float32Array(n)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) elevations[y * width + x] = 0

    const isChannel = new Uint8Array(n)
    const nearestChannel = new Int32Array(n).fill(-1)
    const stageM = new Float64Array(n)
    for (let y = 0; y < height; y++) {
      const river = y * width + 0
      isChannel[river] = 1
      stageM[river] = stage
      for (let x = 0; x < width; x++) nearestChannel[y * width + x] = river
    }
    // Flat ground at 0 and stage above it: the whole transect would be wet.
    const depths = new Float32Array(n).fill(stage)

    const crestM = new Float32Array(n).fill(Number.NEGATIVE_INFINITY)
    for (let y = 0; y < height; y++) crestM[y * width + 20] = leveeHeightM

    return { depths, stageM, nearestChannel, isChannel, elevations, crestM, width, height }
  }

  it('keeps land behind an un-overtopped embankment dry', () => {
    const s = scene(5, 2) // crest 5 m, water surface 2 m
    const result = applyLeveeProtection(s)
    expect(result.depths[10]).toBeGreaterThan(0) // river side
    expect(result.depths[20]).toBe(0) // the embankment itself
    expect(result.depths[30]).toBe(0) // protected side
    expect(result.protectedCells).toBeGreaterThan(0)
  })

  it('floods straight through once the water tops the crest', () => {
    const s = scene(1, 3) // crest 1 m, water surface 3 m
    const result = applyLeveeProtection(s)
    expect(result.depths[30]).toBeGreaterThan(0)
    expect(result.protectedCells).toBe(0)
  })

  it('lets water through a breach in an otherwise intact embankment', () => {
    const s = scene(5, 2)
    const intact = applyLeveeProtection(s)
    expect(intact.depths[1 * s.width + 30]).toBe(0)

    // Fail the embankment on the middle row only.
    const breachOpen = openBreaches([1 * s.width + 20], s.width, s.height, 1)
    const breached = applyLeveeProtection({ ...s, breachOpen })
    expect(breached.depths[1 * s.width + 30]).toBeGreaterThan(0)
    expect(breached.protectedCells).toBeLessThan(intact.protectedCells)
  })

  it('changes nothing where no embankments are mapped', () => {
    const s = scene(5, 2)
    const bare = { ...s, crestM: new Float32Array(s.width * s.height).fill(Number.NEGATIVE_INFINITY) }
    const result = applyLeveeProtection(bare)
    expect(result.protectedCells).toBe(0)
    for (let i = 0; i < s.width * s.height; i++) expect(result.depths[i]).toBe(s.depths[i])
  })

  it('never invents water the fluvial field did not have', () => {
    const s = scene(5, 2)
    const result = applyLeveeProtection(s)
    for (let i = 0; i < s.width * s.height; i++) {
      expect(result.depths[i]!).toBeLessThanOrEqual(s.depths[i]!)
    }
  })
})

describe('opening a breach', () => {
  it('marks a disc around each failure and nothing else', () => {
    const open = openBreaches([5 * 20 + 10], 20, 11, 2)
    expect(open[5 * 20 + 10]).toBe(1)
    expect(open[5 * 20 + 12]).toBe(1)
    expect(open[5 * 20 + 13]).toBe(0)
    expect(open[0]).toBe(0)
  })
})
