import { describe, expect, it } from 'vitest'
import { maskPermanentWater, rasteriseWaterBodies, type WaterBody } from './water'
import { TILE_SIZE, type ElevationMosaic } from './terrain'
import { tile2lat, tile2lon } from '../geometry/tiles'

/** One tile at z12, so a cell is ~30 m — the resolution the model actually runs at. */
const ZOOM = 12
const MOSAIC: ElevationMosaic = {
  zoom: ZOOM,
  minTileX: 3596,
  minTileY: 1614,
  width: TILE_SIZE,
  height: TILE_SIZE,
  elevations: new Float32Array(TILE_SIZE * TILE_SIZE),
  bbox: [
    tile2lon(3596, ZOOM),
    tile2lat(1615, ZOOM),
    tile2lon(3597, ZOOM),
    tile2lat(1614, ZOOM),
  ],
}

/** Longitude/latitude of a cell centre, so a test can name a cell in real coordinates. */
const centreOf = (col: number, row: number): readonly [number, number] => [
  tile2lon(MOSAIC.minTileX + (col + 0.5) / TILE_SIZE, ZOOM),
  tile2lat(MOSAIC.minTileY + (row + 0.5) / TILE_SIZE, ZOOM),
]

/** An axis-aligned box covering the cell-centre range [c0..c1] x [r0..r1]. */
const boxOver = (c0: number, r0: number, c1: number, r1: number): WaterBody => {
  const [west, north] = centreOf(c0 - 0.4, r0 - 0.4)
  const [east, south] = centreOf(c1 + 0.4, r1 + 0.4)
  return {
    rings: [
      [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    ],
  }
}

const cellsSet = (mask: Uint8Array): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) out.push([i % TILE_SIZE, Math.floor(i / TILE_SIZE)])
  }
  return out
}

describe('rasterising water bodies', () => {
  it('fills the cells a polygon covers, and only those', () => {
    const { isWater, waterCells, bodiesBurned } = rasteriseWaterBodies(
      [boxOver(10, 20, 12, 22)],
      MOSAIC,
    )
    expect(waterCells).toBe(9)
    expect(bodiesBurned).toBe(1)
    expect(cellsSet(isWater)).toEqual([
      [10, 20], [11, 20], [12, 20],
      [10, 21], [11, 21], [12, 21],
      [10, 22], [11, 22], [12, 22],
    ])
  })

  it('treats an inner ring as an island, not as more water', () => {
    // A 5x5 lake with its middle cell held out by a hole.
    const outer = boxOver(30, 30, 34, 34).rings[0]!
    const hole = boxOver(32, 32, 32, 32).rings[0]!
    const { isWater, waterCells } = rasteriseWaterBodies([{ rings: [outer, hole] }], MOSAIC)
    expect(waterCells).toBe(24)
    expect(isWater[32 * TILE_SIZE + 32]).toBe(0)
    expect(isWater[31 * TILE_SIZE + 32]).toBe(1)
  })

  it('unions overlapping bodies instead of cancelling them', () => {
    // Two lakes sharing a column: even-odd applies within a body, never across.
    const { waterCells } = rasteriseWaterBodies(
      [boxOver(50, 50, 52, 52), boxOver(52, 50, 54, 52)],
      MOSAIC,
    )
    expect(waterCells).toBe(15)
  })

  it('counts a body that lands entirely outside the grid as unburned', () => {
    const faraway: WaterBody = {
      rings: [
        [
          [100, 10],
          [100.01, 10],
          [100.01, 10.01],
          [100, 10.01],
        ],
      ],
    }
    const { waterCells, bodiesBurned } = rasteriseWaterBodies([faraway], MOSAIC)
    expect(waterCells).toBe(0)
    expect(bodiesBurned).toBe(0)
  })

  it('ignores a degenerate ring rather than throwing', () => {
    const { waterCells } = rasteriseWaterBodies([{ rings: [[[139, 36], [139, 36]]] }], MOSAIC)
    expect(waterCells).toBe(0)
  })

  it('closes a ring whose last vertex does not repeat the first', () => {
    const open = boxOver(70, 70, 72, 72)
    const closed: WaterBody = { rings: [[...open.rings[0]!, open.rings[0]![0]!]] }
    expect(rasteriseWaterBodies([open], MOSAIC).waterCells).toBe(
      rasteriseWaterBodies([closed], MOSAIC).waterCells,
    )
  })
})

describe('masking permanent water from a depth field', () => {
  const rowAreaM2 = new Float64Array(TILE_SIZE).fill(900)

  it('drops wet cells that are already water and counts the area', () => {
    const depths = new Float32Array(TILE_SIZE * TILE_SIZE)
    depths[20 * TILE_SIZE + 10] = 2.5
    depths[20 * TILE_SIZE + 11] = 1.0
    const isWater = new Uint8Array(TILE_SIZE * TILE_SIZE)
    isWater[20 * TILE_SIZE + 10] = 1

    const result = maskPermanentWater(depths, isWater, rowAreaM2, TILE_SIZE)
    expect(result.maskedCells).toBe(1)
    expect(result.maskedAreaM2).toBe(900)
    expect(result.depths[20 * TILE_SIZE + 10]).toBe(0)
    // The neighbour is flooding beyond the shoreline and must survive.
    expect(result.depths[20 * TILE_SIZE + 11]).toBe(1)
  })

  it('does not count a dry water cell as masked', () => {
    const depths = new Float32Array(4)
    const isWater = Uint8Array.of(1, 1, 1, 1)
    const result = maskPermanentWater(depths, isWater, Float64Array.of(900), 4)
    expect(result.maskedCells).toBe(0)
    expect(result.maskedAreaM2).toBe(0)
  })

  it('never mutates the field it was given', () => {
    const depths = Float32Array.of(3, 3, 3, 3)
    const isWater = Uint8Array.of(1, 0, 1, 0)
    const result = maskPermanentWater(depths, isWater, Float64Array.of(900), 4)
    expect([...depths]).toEqual([3, 3, 3, 3])
    expect([...result.depths]).toEqual([0, 3, 0, 3])
  })
})
