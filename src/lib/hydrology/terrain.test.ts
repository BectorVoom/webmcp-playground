import { describe, expect, it } from 'vitest'
import {
  TILE_SIZE,
  buildMosaic,
  decodeGsiDemElevations,
  decodeTerrariumElevations,
  despikeElevations,
  fillElevationVoids,
  mosaicGeometry,
  tileRangeForCircle,
} from './terrain'

const rgbaOf = (r: number, g: number, b: number): Uint8Array => Uint8Array.of(r, g, b, 255)

describe('Terrarium elevation decoding', () => {
  it('decodes the published encoding: (R·256 + G + B/256) − 32768', () => {
    expect(decodeTerrariumElevations(rgbaOf(128, 0, 0), 1, 1)[0]).toBe(0)
    expect(decodeTerrariumElevations(rgbaOf(129, 0, 0), 1, 1)[0]).toBe(256)
    expect(decodeTerrariumElevations(rgbaOf(128, 100, 128), 1, 1)[0]).toBeCloseTo(100.5, 5)
    expect(decodeTerrariumElevations(rgbaOf(127, 255, 0), 1, 1)[0]).toBe(-1)
  })

  it('rejects a buffer shorter than the pixel count claims', () => {
    expect(() => decodeTerrariumElevations(new Uint8Array(8), 2, 2)).toThrow(/bytes/)
  })
})

describe('GSI elevation decoding', () => {
  it('decodes the published encoding: signed 24-bit centimetres', () => {
    expect(decodeGsiDemElevations(rgbaOf(0, 0, 0), 1, 1)[0]).toBe(0)
    // 0x000064 = 100 cm = 1 m
    expect(decodeGsiDemElevations(rgbaOf(0, 0, 100), 1, 1)[0]).toBeCloseTo(1, 5)
    // 0x0186A0 = 100000 cm = 1000 m
    expect(decodeGsiDemElevations(rgbaOf(0x01, 0x86, 0xa0), 1, 1)[0]).toBeCloseTo(1000, 5)
    // 0xFFFFFF = -1 cm, the wrap that makes below-sea-level ground representable
    expect(decodeGsiDemElevations(rgbaOf(255, 255, 255), 1, 1)[0]).toBeCloseTo(-0.01, 5)
  })

  it('maps the reserved 2^23 sentinel to NaN rather than sea level', () => {
    // A void decoded as 0 would become the deepest hole on the map.
    expect(decodeGsiDemElevations(rgbaOf(128, 0, 0), 1, 1)[0]).toBeNaN()
  })

  it('is not interchangeable with the Terrarium reader', () => {
    // The same bytes mean 0 m to GSI and 0 m to Terrarium only by coincidence of
    // this one pixel; a metre of GSI ground reads as 256 m of Terrarium ground.
    const oneMetreGsi = rgbaOf(0, 0, 100)
    expect(decodeGsiDemElevations(oneMetreGsi, 1, 1)[0]).toBeCloseTo(1, 5)
    expect(decodeTerrariumElevations(oneMetreGsi, 1, 1)[0]).toBeCloseTo(-32767.6, 1)
  })

  it('rejects a buffer shorter than the pixel count claims', () => {
    expect(() => decodeGsiDemElevations(new Uint8Array(8), 2, 2)).toThrow(/bytes/)
  })
})

describe('void filling', () => {
  it('leaves a void-free grid untouched', () => {
    const grid = Float32Array.from([1, 2, 3, 4])
    expect(fillElevationVoids(grid, 2, 2)).toBe(0)
    expect([...grid]).toEqual([1, 2, 3, 4])
  })

  it('fills a void from its nearest measured neighbour', () => {
    const grid = Float32Array.from([10, 10, 10, 10, NaN, 10, 10, 10, 10])
    expect(fillElevationVoids(grid, 3, 3)).toBe(1)
    expect(grid[4]).toBeCloseTo(10, 5)
  })

  it('takes the nearer of two measured sides, not their average', () => {
    // Row of five: measured 0 at the left, measured 100 at the right.
    const grid = Float32Array.from([0, NaN, NaN, NaN, 100])
    expect(fillElevationVoids(grid, 5, 1)).toBe(3)
    expect(grid[1]).toBe(0)
    expect(grid[3]).toBe(100)
  })

  it('fills a void far wider than any fixed pass budget', () => {
    // The failure this replaced: an inward-relaxing fill advances one cell per
    // sweep, so a sea-sized void kept its NaN centre and silently poisoned the
    // hydrology downstream. 400 cells is deeper than any such budget.
    const width = 400
    const grid = new Float32Array(width).fill(NaN)
    grid[0] = 7
    expect(fillElevationVoids(grid, width, 1)).toBe(width - 1)
    expect([...grid].every(Number.isFinite)).toBe(true)
    for (const value of grid) expect(value).toBe(7)
  })

  it('leaves a coastal void at about shore level rather than damming it', () => {
    // Land descending to a 0 m shore, then open water with no measurement.
    const grid = Float32Array.from([50, 20, 0, NaN, NaN, NaN])
    fillElevationVoids(grid, 6, 1)
    for (const value of grid.slice(3)) expect(value).toBe(0)
  })

  it('reports a shortfall when a grid is entirely void rather than inventing ground', () => {
    const grid = Float32Array.from([NaN, NaN, NaN, NaN])
    expect(fillElevationVoids(grid, 2, 2)).toBe(0)
    expect([...grid].every(Number.isNaN)).toBe(true)
  })
})

describe('DEM mosaic assembly', () => {
  const flatTile = (x: number, y: number, elevation: number) => ({
    x,
    y,
    width: TILE_SIZE,
    height: TILE_SIZE,
    elevations: new Float32Array(TILE_SIZE * TILE_SIZE).fill(elevation),
  })

  it('places each tile at its slippy position, west to east and north to south', () => {
    const range = { zoom: 11, minX: 1817, maxX: 1818, minY: 806, maxY: 806, count: 2 }
    const mosaic = buildMosaic(range, [flatTile(1818, 806, 20), flatTile(1817, 806, 10)])

    expect(mosaic.width).toBe(2 * TILE_SIZE)
    expect(mosaic.height).toBe(TILE_SIZE)
    expect(mosaic.elevations[0]).toBe(10)
    expect(mosaic.elevations[TILE_SIZE]).toBe(20)
    const [minLon, minLat, maxLon, maxLat] = mosaic.bbox
    expect(minLon).toBeLessThan(maxLon)
    expect(minLat).toBeLessThan(maxLat)
  })

  it('refuses a mosaic with a hole — a missing tile would reroute simulated water', () => {
    const range = { zoom: 11, minX: 0, maxX: 1, minY: 0, maxY: 0, count: 2 }
    expect(() => buildMosaic(range, [flatTile(0, 0, 5)])).toThrow(/tiles/)
  })

  it('computes per-row cell areas that shrink toward the pole', () => {
    const range = { zoom: 11, minX: 1817, maxX: 1817, minY: 806, maxY: 806, count: 1 }
    const mosaic = buildMosaic(range, [flatTile(1817, 806, 0)])
    const geometry = mosaicGeometry(mosaic)

    expect(geometry.rowLatitudes[0]!).toBeGreaterThan(geometry.rowLatitudes[TILE_SIZE - 1]!)
    // Tile y=806 at z11 is in the northern hemisphere: the northernmost row
    // has narrower cells than the southernmost.
    expect(geometry.rowCellAreaM2[0]!).toBeLessThan(geometry.rowCellAreaM2[TILE_SIZE - 1]!)
    // z11 pixels are ~60–80 m at mid-latitudes; sanity-bound the area.
    expect(geometry.rowCellAreaM2[0]!).toBeGreaterThan(1000)
    expect(geometry.rowCellAreaM2[0]!).toBeLessThan(10000)
  })
})

describe('DEM despiking', () => {
  const grid = (rows: ReadonlyArray<ReadonlyArray<number>>): Float32Array =>
    Float32Array.from(rows.flat())

  it('heals an isolated void pixel and an adjacent void pair in one pass', () => {
    const elevations = grid([
      [10, 10, 10, 10, 10, 10],
      [10, -100, 10, 10, 10, 10],
      [10, 10, 10, -122, -62, 10],
      [10, 10, 10, 10, 10, 10],
    ])
    const replaced = despikeElevations(elevations, 6, 4)
    expect(replaced).toBe(3)
    expect(elevations[1 * 6 + 1]).toBe(10)
    expect(elevations[2 * 6 + 3]).toBe(10)
    expect(elevations[2 * 6 + 4]).toBe(10)
  })

  it('never touches border cells — a valley outlet at the domain edge must stay open', () => {
    const elevations = grid([
      [150, 100, 150],
      [150, 100, 150],
      [150, 100, 150],
    ])
    expect(despikeElevations(elevations, 3, 3)).toBe(0)
    expect(elevations[1]).toBe(100)
  })

  it('leaves a one-cell-wide gorge floor alone — it has along-valley company at its level', () => {
    const elevations = grid([
      [150, 100, 150],
      [150, 100, 150],
      [150, 100, 150],
      [150, 100, 150],
    ])
    const replaced = despikeElevations(elevations, 3, 4)
    expect(replaced).toBe(0)
    expect(elevations[1 * 3 + 1]).toBe(100)
  })

  it('leaves gentle depressions within the threshold untouched', () => {
    const elevations = grid([
      [10, 10, 10],
      [10, 2, 10],
      [10, 10, 10],
    ])
    expect(despikeElevations(elevations, 3, 3)).toBe(0)
    expect(elevations[4]).toBe(2)
  })
})

describe('tile range for a query circle', () => {
  it('covers a 20 km circle at z11 with a small rectangle', () => {
    const range = tileRangeForCircle({ latitude: 35.68, longitude: 139.77 }, 20, 11)
    expect(range.count).toBeGreaterThanOrEqual(4)
    expect(range.count).toBeLessThanOrEqual(25)
    expect(range.maxX).toBeGreaterThanOrEqual(range.minX)
    expect(range.maxY).toBeGreaterThanOrEqual(range.minY)
  })
})
