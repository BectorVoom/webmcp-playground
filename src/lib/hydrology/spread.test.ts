import { describe, expect, it } from 'vitest'
import { priorityFlood } from './flow'
import { spreadRunoff, type SpreadResult } from './spread'

const uniformAreas = (height: number, areaM2 = 1): Float64Array => new Float64Array(height).fill(areaM2)

const conserves = (result: SpreadResult): void => {
  expect(result.storedM3 + result.outflowM3).toBeCloseTo(result.totalRunoffM3, 6)
}

describe('runoff spreading (priority-flood + level-pool fill-and-spill)', () => {
  it('ponds nothing on a tilted plane — every drop exits the domain', () => {
    const width = 8
    const height = 8
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) elevations[y * width + x] = x * 0.5
    }

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.1,
      rowCellAreaM2: uniformAreas(height),
    })

    conserves(result)
    expect(result.depressionCount).toBe(0)
    expect(result.storedM3).toBe(0)
    expect(result.outflowM3).toBeCloseTo(6.4, 6)
    expect(Math.max(...result.depths)).toBe(0)
  })

  it('fills a bowl to the exact level its inflow volume dictates', () => {
    // Concentric square rings: elevation = Chebyshev distance from the centre.
    // The inner 5×5 is one depression spilling over the ring-3 border at 3 m.
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.1,
      rowCellAreaM2: uniformAreas(height),
    })

    conserves(result)
    expect(result.depressionCount).toBe(1)
    expect(result.overflowingCount).toBe(0)
    // 25 depression cells × 0.1 m × 1 m² pond; the 24 border cells drain out.
    expect(result.storedM3).toBeCloseTo(2.5, 6)
    expect(result.outflowM3).toBeCloseTo(2.4, 6)
    // Level-pool: 1 m³ fills the pit to +1; the remaining 1.5 m³ spreads over
    // 9 cells → surface at 1 + 1.5/9 ≈ 1.1667 m.
    const centreDepth = result.depths[3 * width + 3]!
    const ring1Depth = result.depths[3 * width + 4]!
    const ring2Depth = result.depths[3 * width + 5]!
    expect(centreDepth).toBeCloseTo(1 + 1.5 / 9, 4)
    expect(ring1Depth).toBeCloseTo(1.5 / 9, 4)
    expect(ring2Depth).toBe(0)
  })

  it('caps a bowl at its spill level and sends the excess out of the domain', () => {
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 2,
      rowCellAreaM2: uniformAreas(height),
    })

    conserves(result)
    expect(result.overflowingCount).toBe(1)
    // Capacity: 1·3 + 8·2 + 16·1 = 35 m³; inflow 25·2 = 50 m³.
    expect(result.storedM3).toBeCloseTo(35, 6)
    expect(result.depths[3 * width + 3]!).toBeCloseTo(3, 4)
    expect(result.depths[3 * width + 4]!).toBeCloseTo(2, 4)
    expect(result.depths[3 * width + 5]!).toBeCloseTo(1, 4)
  })

  it('cascades overflow from an upstream pit into the next pit downstream', () => {
    // A walled channel: pit A (3 m, spill 7) overflows across the 7 m saddle
    // into pit B (2 m, spill 6), which overflows out through the left edge.
    const width = 6
    const height = 3
    const channel = [5, 6, 2, 7, 3, 8]
    const elevations = new Float32Array(width * height).fill(20)
    for (let x = 0; x < width; x++) elevations[width + x] = channel[x]!

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 6,
      rowCellAreaM2: uniformAreas(height),
    })

    conserves(result)
    expect(result.depressionCount).toBe(2)
    expect(result.overflowingCount).toBe(2)
    // Both single-cell pits hold exactly 4 m³ (spill − floor over 1 m²).
    expect(result.storedM3).toBeCloseTo(8, 6)
    expect(result.depths[width + 4]!).toBeCloseTo(4, 4) // pit A full to its 7 m spill
    expect(result.depths[width + 2]!).toBeCloseTo(4, 4) // pit B full to its 6 m spill
  })

  it('leaves a downstream pit dry when the upstream pit swallows everything', () => {
    const width = 6
    const height = 3
    const channel = [5, 6, 2, 7, 3, 8]
    const elevations = new Float32Array(width * height).fill(20)
    for (let x = 0; x < width; x++) elevations[width + x] = channel[x]!

    // 1 m of runoff: pit A receives only its own cell's 1 m³ (< 4 m³ capacity),
    // so nothing spills over the saddle; pit B ponds only its own catchment.
    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 1,
      rowCellAreaM2: uniformAreas(height),
    })

    conserves(result)
    expect(result.overflowingCount).toBe(0)
    expect(result.depths[width + 4]!).toBeCloseTo(1, 4)
    // Pit B's catchment includes the saddle cell, whose water drains to it.
    expect(result.depths[width + 2]!).toBeCloseTo(2, 4)
  })

  it('respects per-row cell areas when balancing volume', () => {
    // Same bowl, but southern rows twice the area: the stored volume must use
    // true areas, and the ponded surface must still be flat.
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }
    const areas = new Float64Array(height)
    for (let y = 0; y < height; y++) areas[y] = y < 4 ? 1 : 2

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.1,
      rowCellAreaM2: areas,
    })

    conserves(result)
    // The surface is flat: all ring-1 cells share one depth.
    const ringDepths = [
      result.depths[2 * width + 3]!,
      result.depths[4 * width + 3]!,
      result.depths[3 * width + 2]!,
      result.depths[3 * width + 4]!,
    ]
    for (const d of ringDepths) expect(d).toBeCloseTo(ringDepths[0]!, 5)
  })

  it('masks the sea as an outlet but keeps an isolated polder as a depression', () => {
    // Columns 6–8 sit at −5 m and touch the east edge: that is the sea, and it
    // must neither pond nor be counted as a depression. The −2 m cell at
    // (2, 2) is a polder ringed by 10 m ground — below sea level but not
    // connected to it, so it still ponds.
    const width = 9
    const height = 5
    const elevations = new Float32Array(width * height).fill(10)
    for (let y = 0; y < height; y++) {
      for (let x = 6; x < 9; x++) elevations[y * width + x] = -5
    }
    elevations[2 * width + 2] = -2

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.5,
      rowCellAreaM2: uniformAreas(height),
      oceanLevelMetres: 0,
    })

    conserves(result)
    expect(result.oceanCellCount).toBe(15)
    for (let y = 0; y < height; y++) {
      for (let x = 6; x < 9; x++) expect(result.depths[y * width + x]).toBe(0)
    }
    expect(result.depressionCount).toBe(1)
    expect(result.depths[2 * width + 2]!).toBeCloseTo(0.5, 5)
  })

  it('ponds an injected volume exactly, with no rain at all', () => {
    // 10 m³ into the bowl's pit: 1 m³ raises the pit to the ring-1 level, the
    // remaining 9 m³ spread over the 9 cells at that level, so the surface
    // lands exactly on 2 m.
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }
    const inflowM3 = new Float64Array(width * height)
    inflowM3[3 * width + 3] = 10

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0,
      rowCellAreaM2: uniformAreas(height),
      inflowM3,
    })

    conserves(result)
    expect(result.totalRunoffM3).toBeCloseTo(10, 6)
    expect(result.storedM3).toBeCloseTo(10, 6)
    expect(result.outflowM3).toBeCloseTo(0, 6)
    expect(result.depths[3 * width + 3]!).toBeCloseTo(2, 4)
    expect(result.depths[3 * width + 4]!).toBeCloseTo(1, 4)
    expect(result.depths[3 * width + 5]!).toBeCloseTo(0, 4)
  })

  it('carries water through a bowl when a channel through it has the capacity', () => {
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }
    // A river running through the basin, outlet included, with room for
    // everything the bowl receives.
    const conveyanceM3 = new Float64Array(width * height).fill(10)

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.1,
      rowCellAreaM2: uniformAreas(height),
      conveyanceM3,
    })

    conserves(result)
    expect(result.conveyedM3).toBeCloseTo(2.5, 6)
    expect(result.storedM3).toBeCloseTo(0, 6)
    expect(result.outflowM3).toBeCloseTo(4.9, 6)
    expect(Math.max(...result.depths)).toBe(0)
  })

  it('floods a bowl with exactly what its channel cannot carry', () => {
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }
    // Capacity 1.0 of the 2.5 m³ arriving: 1.5 m³ has to pond.
    const conveyanceM3 = new Float64Array(width * height).fill(1)

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.1,
      rowCellAreaM2: uniformAreas(height),
      conveyanceM3,
    })

    conserves(result)
    expect(result.conveyedM3).toBeCloseTo(1, 6)
    expect(result.storedM3).toBeCloseTo(1.5, 6)
    // 1 m³ fills the pit to the ring-1 level, the last 0.5 m³ spreads over 9 cells.
    expect(result.depths[3 * width + 3]!).toBeCloseTo(1 + 0.5 / 9, 4)
  })

  it('gives a closed basin no conveyance, however large the river draining into it', () => {
    // Capacity at the pit but none at the rim: a basin whose only way out is a
    // saddle cannot pass water downstream, and crediting the inflowing river's
    // capacity would drain it uphill.
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }
    const conveyanceM3 = new Float64Array(width * height)
    conveyanceM3[3 * width + 3] = 1000

    const result = spreadRunoff({
      elevations,
      width,
      height,
      runoffMetres: 0.1,
      rowCellAreaM2: uniformAreas(height),
      conveyanceM3,
    })

    conserves(result)
    expect(result.conveyedM3).toBe(0)
    expect(result.storedM3).toBeCloseTo(2.5, 6)
    expect(result.depths[3 * width + 3]!).toBeCloseTo(1 + 1.5 / 9, 4)
  })

  it('gives byte-identical results whether or not the surface is handed in', () => {
    // The route computes the filled surface once and shares it; that must be a
    // pure saving, never a change of answer.
    const width = 7
    const height = 7
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      }
    }
    const inflowM3 = new Float64Array(width * height)
    inflowM3[3 * width + 3] = 4
    const conveyanceM3 = new Float64Array(width * height).fill(0.3)
    const base = {
      elevations,
      width,
      height,
      runoffMetres: 0.4,
      rowCellAreaM2: uniformAreas(height),
      oceanLevelMetres: 0,
      inflowM3,
      conveyanceM3,
    }

    const computed = spreadRunoff(base)
    const shared = spreadRunoff({ ...base, surface: priorityFlood(elevations, width, height, 0) })

    expect(Array.from(shared.depths)).toEqual(Array.from(computed.depths))
    expect(shared.storedM3).toBe(computed.storedM3)
    expect(shared.outflowM3).toBe(computed.outflowM3)
    expect(shared.conveyedM3).toBe(computed.conveyedM3)
    expect(shared.depressionCount).toBe(computed.depressionCount)
    expect(Array.from(shared.labels)).toEqual(Array.from(computed.labels))
  })

  it('refuses a handed-in surface that does not fit the grid', () => {
    expect(() =>
      spreadRunoff({
        elevations: new Float32Array(16),
        width: 4,
        height: 4,
        runoffMetres: 0.1,
        rowCellAreaM2: uniformAreas(4),
        surface: priorityFlood(new Float32Array(9), 3, 3),
      }),
    ).toThrow(/surface/)
  })

  it('rejects injection and conveyance arrays that do not match the grid', () => {
    const base = {
      elevations: new Float32Array(16),
      width: 4,
      height: 4,
      runoffMetres: 0.1,
      rowCellAreaM2: uniformAreas(4),
    }
    expect(() => spreadRunoff({ ...base, inflowM3: new Float64Array(9) })).toThrow(/inflowM3/)
    expect(() => spreadRunoff({ ...base, conveyanceM3: new Float64Array(9) })).toThrow(/conveyanceM3/)
  })

  it('rejects mismatched grid dimensions', () => {
    expect(() =>
      spreadRunoff({
        elevations: new Float32Array(10),
        width: 4,
        height: 4,
        runoffMetres: 0.1,
        rowCellAreaM2: uniformAreas(4),
      }),
    ).toThrow(/cells/)
  })
})
