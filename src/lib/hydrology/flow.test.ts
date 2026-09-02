import { describe, expect, it } from 'vitest'
import {
  breachSpuriousDepressions,
  channelMask,
  d8Receivers,
  downstreamSlope,
  findInlets,
  flowAccumulate,
  priorityFlood,
  type GridGeometry,
} from './flow'

/** Square cells of a given ground size, for grids where latitude is irrelevant. */
const uniformGeometry = (height: number, metres = 100): GridGeometry => ({
  rowCellWidthM: new Float64Array(height).fill(metres),
  rowCellHeightM: new Float64Array(height).fill(metres),
  rowCellAreaM2: new Float64Array(height).fill(metres * metres),
})

/** Plane falling 0.5 m per cell toward the west. */
const tiltedPlane = (width: number, height: number): Float32Array => {
  const e = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) e[y * width + x] = x * 0.5
  return e
}

describe('priority-flood surface', () => {
  it('raises a pit to its spill level and leaves a slope untouched', () => {
    const elevations = Float32Array.from([
      10, 10, 10, 10,
      10, 2, 3, 10,
      10, 10, 10, 10,
    ])
    const s = priorityFlood(elevations, 4, 3)
    expect(s.filled[1 * 4 + 1]).toBe(10)
    expect(s.filled[1 * 4 + 2]).toBe(10)
    expect(s.filled[0]).toBe(10)

    const plane = tiltedPlane(6, 4)
    const flat = priorityFlood(plane, 6, 4)
    for (let i = 0; i < plane.length; i++) expect(flat.filled[i]).toBe(plane[i])
  })

  it('pops outlets before headwaters, so pop index measures distance to an outlet', () => {
    const s = priorityFlood(tiltedPlane(6, 4), 6, 4)
    expect(s.popIndex[0]).toBeLessThan(s.popIndex[1 * 6 + 3]!)
    expect(s.popOrder.length).toBe(24)
    expect(new Set(Array.from(s.popOrder)).size).toBe(24)
  })
})

describe('D8 flow directions', () => {
  it('sends every interior cell of a tilted plane due west, not diagonally', () => {
    const width = 8
    const height = 8
    const surface = priorityFlood(tiltedPlane(width, height), width, height)
    const receivers = d8Receivers(surface, width, height, uniformGeometry(height))

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        expect(receivers[y * width + x]).toBe(y * width + (x - 1))
      }
    }
  })

  it('marks boundary cells as outlets', () => {
    const width = 6
    const height = 5
    const surface = priorityFlood(tiltedPlane(width, height), width, height)
    const receivers = d8Receivers(surface, width, height, uniformGeometry(height))
    for (let x = 0; x < width; x++) {
      expect(receivers[x]).toBe(-1)
      expect(receivers[(height - 1) * width + x]).toBe(-1)
    }
  })

  it('drains a filled flat toward its outlet rather than stalling on it', () => {
    // A wide flat pit: every filled elevation is identical, so only the
    // pop-order tie-break can pick a way out.
    const width = 7
    const height = 5
    const elevations = new Float32Array(width * height).fill(10)
    for (let y = 1; y < 4; y++) for (let x = 1; x < 6; x++) elevations[y * width + x] = 2
    elevations[2 * width + 0] = 1 // the one low boundary cell: the outlet

    const surface = priorityFlood(elevations, width, height)
    const receivers = d8Receivers(surface, width, height, uniformGeometry(height))

    // Every interior cell must reach a boundary in finite steps.
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let c = y * width + x
        let steps = 0
        while (receivers[c]! >= 0 && steps < width * height) {
          c = receivers[c]!
          steps++
        }
        expect(receivers[c]).toBe(-1)
        expect(steps).toBeLessThan(width * height)
      }
    }
  })
})

describe('flow accumulation', () => {
  it('grows downslope and conserves the total weight it was given', () => {
    const width = 8
    const height = 8
    const surface = priorityFlood(tiltedPlane(width, height), width, height)
    const receivers = d8Receivers(surface, width, height, uniformGeometry(height))
    const accumulated = flowAccumulate(receivers, surface.popOrder, new Float64Array(width * height).fill(1))

    // Interior row: x=6 collects only itself, x=1 collects x=1..6, and the
    // boundary cell at x=0 holds all of them plus its own.
    expect(accumulated[4 * width + 6]).toBe(1)
    expect(accumulated[4 * width + 1]).toBe(6)
    expect(accumulated[4 * width + 0]).toBe(7)

    let atOutlets = 0
    for (let i = 0; i < width * height; i++) if (receivers[i]! < 0) atOutlets += accumulated[i]!
    expect(atOutlets).toBe(width * height)
  })
})

describe('channel extraction and slope', () => {
  it('keeps only cells above the contributing-area threshold', () => {
    const areas = Float64Array.from([0, 5e6, 1e7, 2e7])
    expect(Array.from(channelMask(areas, 1e7))).toEqual([0, 0, 1, 1])
  })

  it('measures slope over a reach, not a single cell', () => {
    const width = 8
    const height = 8
    const surface = priorityFlood(tiltedPlane(width, height), width, height)
    const geometry = uniformGeometry(height)
    const receivers = d8Receivers(surface, width, height, geometry)
    const slopes = downstreamSlope(surface, receivers, width, geometry, 10)
    // 0.5 m drop per 100 m cell = 0.005, held all the way down the reach.
    expect(slopes[4 * width + 6]).toBeCloseTo(0.005, 6)
  })

  it('never reports a zero slope — Manning would read it as infinite capacity', () => {
    const width = 5
    const height = 5
    const flat = new Float32Array(width * height).fill(7)
    const surface = priorityFlood(flat, width, height)
    const geometry = uniformGeometry(height)
    const receivers = d8Receivers(surface, width, height, geometry)
    for (const s of downstreamSlope(surface, receivers, width, geometry)) {
      expect(s).toBeGreaterThan(0)
    }
  })
})

describe('breaching spurious depressions', () => {
  it('carves through a thin dam across a valley', () => {
    // A valley falling west to east with a one-cell ridge thrown across it —
    // the shape an unresolved gorge takes on a coarse DEM.
    const width = 14
    const height = 5
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = 100 - x * 2 + Math.abs(y - 2) * 30
      }
    }
    for (let y = 1; y < height - 1; y++) elevations[y * width + 8] = 120

    const before = priorityFlood(elevations, width, height)
    let deepestBefore = 0
    for (let i = 0; i < elevations.length; i++) {
      deepestBefore = Math.max(deepestBefore, before.filled[i]! - elevations[i]!)
    }
    expect(deepestBefore).toBeGreaterThan(5)

    const report = breachSpuriousDepressions(elevations, width, height, { minDepthMetres: 5 })
    expect(report.depressionsBreached).toBeGreaterThan(0)
    expect(report.cellsCarved).toBeGreaterThan(0)
    expect(report.deepestAfterMetres).toBeLessThan(report.deepestBeforeMetres)
    // The dam column has been cut through somewhere, not raised. Which cell of
    // an equally-thick dam gets carved is not something to pin down.
    let lowestInDam = Infinity
    for (let y = 1; y < height - 1; y++) lowestInDam = Math.min(lowestInDam, elevations[y * width + 8]!)
    expect(lowestInDam).toBeLessThan(120)
  })

  it('leaves a genuine closed basin alone — there is no short way out', () => {
    // A broad crater in the middle of high ground: no outlet within reach, so
    // filling is the correct answer and nothing should be carved.
    const width = 31
    const height = 31
    const elevations = new Float32Array(width * height).fill(500)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const r = Math.hypot(x - 15, y - 15)
        if (r < 12) elevations[y * width + x] = 400 + r
      }
    }
    const copy = Float32Array.from(elevations)
    const report = breachSpuriousDepressions(copy, width, height, { minDepthMetres: 5, maxLengthCells: 6 })
    expect(report.depressionsBreached).toBe(0)
    expect(report.cellsCarved).toBe(0)
    expect(Array.from(copy)).toEqual(Array.from(elevations))
  })

  it('never raises ground, only lowers it', () => {
    const width = 14
    const height = 5
    const elevations = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        elevations[y * width + x] = 100 - x * 2 + Math.abs(y - 2) * 30
      }
    }
    for (let y = 1; y < height - 1; y++) elevations[y * width + 8] = 120
    const before = Float32Array.from(elevations)

    breachSpuriousDepressions(elevations, width, height, { minDepthMetres: 5 })
    for (let i = 0; i < elevations.length; i++) {
      expect(elevations[i]!).toBeLessThanOrEqual(before[i]! + 1e-6)
    }
  })
})

describe('inlets: where a river enters the modelled window', () => {
  it('finds the boundary crossing of a large channel and ignores small ones', () => {
    // Four cells in a row; flow runs right to left into the "inside" region.
    const receivers = Int32Array.from([-1, 0, 1, 2])
    const areas = Float64Array.from([4e7, 3e7, 2e7, 5e6])
    const isInside = (c: number) => c <= 1

    const inlets = findInlets(receivers, areas, isInside, 1e7)
    expect(inlets).toHaveLength(1)
    expect(inlets[0]!.cell).toBe(2)
    expect(inlets[0]!.areaM2).toBe(2e7)
  })

  it('ranks several inlets with the trunk river first', () => {
    const receivers = Int32Array.from([-1, 0, 0, 0])
    const areas = Float64Array.from([9e7, 2e7, 6e7, 3e7])
    const inlets = findInlets(receivers, areas, (c) => c === 0, 1e7)
    expect(inlets.map((i) => i.cell)).toEqual([2, 3, 1])
  })

  it('counts a river that leaves and re-enters the region only once', () => {
    // One river, cells 5 -> 4 -> 3 -> 2 -> 1 -> 0. Cells 3 and 1 are inside the
    // region, so the river crosses inward twice: at 4 and again at 2. Both are
    // the same water, and summing them would double the upstream catchment.
    const receivers = Int32Array.from([-1, 0, 1, 2, 3, 4])
    const areas = Float64Array.from([6e7, 5e7, 4e7, 3e7, 2e7, 1e7])
    const isInside = (c: number) => c === 1 || c === 3

    const inlets = findInlets(receivers, areas, isInside, 1e7)
    expect(inlets).toHaveLength(1)
    // The downstream crossing carries the larger catchment, so it is the one kept.
    expect(inlets[0]!.cell).toBe(2)
  })

  it('keeps two genuinely separate tributaries', () => {
    // Two independent streams entering the same region cell from either side.
    //   3 -> 2 -> 0 (inside)   and   5 -> 4 -> 0 (inside)
    const receivers = Int32Array.from([-1, -1, 0, 2, 0, 4])
    const areas = Float64Array.from([9e7, 0, 4e7, 2e7, 3e7, 1e7])
    const inlets = findInlets(receivers, areas, (c) => c === 0, 1e7)
    expect(inlets.map((i) => i.cell).sort()).toEqual([2, 4])
  })
})
