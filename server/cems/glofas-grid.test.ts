import { describe, expect, it } from 'vitest'
import {
  annualMaximaPerCell,
  cellValue,
  classifyForecast,
  EXCEEDANCE_PROBABILITY,
  fieldGridFromMessages,
  gridBBox,
  MIN_YEARS_FOR_FIT,
  returnLevelsPerCell,
  yearsForSlices,
  type CellThresholds,
  type FieldGrid,
} from './glofas-grid'
import { parseGrib2 } from './grib2'
import { writeGrib2, type Grib2FixtureMessage } from './grib2-fixture'

const grid = { ni: 2, nj: 2, lat1: 51.0, lon1: 6.6, di: 0.05, dj: 0.05 }

const decode = (messages: ReadonlyArray<Grib2FixtureMessage>): FieldGrid =>
  fieldGridFromMessages(parseGrib2(writeGrib2(messages)))

describe('fieldGridFromMessages', () => {
  /**
   * A GRIB2 file has no axes — it is a flat pile of fields. Recovering "two lead times of three
   * members" from their stamps, rather than from the order they happen to arrive in, is the whole
   * job of this function.
   */
  it('recovers the time and ensemble axes from the message stamps', () => {
    const messages: Array<Grib2FixtureMessage> = []
    for (const [timeIndex, day] of [31, 1].entries()) {
      for (let member = 0; member < 3; member++) {
        messages.push({
          grid,
          values: [timeIndex * 10 + member, 0, 0, 0],
          validTime: new Date(Date.UTC(2026, day === 31 ? 7 : 8, day)),
          perturbationNumber: member,
        })
      }
    }

    const field = decode(messages)
    expect(field.sliceAxes.map((a) => a.name)).toEqual(['time', 'number'])
    expect(field.sliceAxes[0]!.length).toBe(2)
    expect(field.sliceAxes[1]!.length).toBe(3)
    expect(field.sliceCount).toBe(6)
    expect(field.cellCount).toBe(4)
  })

  /** Order in the file promises nothing, so the axes must come from the stamps, not the bytes. */
  it('does not depend on the order the messages arrive in', () => {
    const build = (perturbations: ReadonlyArray<number>) =>
      decode(
        perturbations.map((member) => ({
          grid,
          values: [member * 100, 0, 0, 0],
          validTime: new Date(Date.UTC(2026, 7, 31)),
          perturbationNumber: member,
        })),
      )

    const ordered = build([0, 1, 2])
    const shuffled = build([2, 0, 1])
    expect(Array.from(shuffled.values)).toEqual(Array.from(ordered.values))
    expect(cellValue(shuffled, 0, 0)).toBe(0)
    expect(cellValue(shuffled, 2, 0)).toBe(200)
  })

  it('orders the time axis oldest first whatever order it was given', () => {
    const field = decode([
      { grid, values: [2, 0, 0, 0], validTime: new Date(Date.UTC(2026, 8, 1)) },
      { grid, values: [1, 0, 0, 0], validTime: new Date(Date.UTC(2026, 7, 31)) },
    ])
    expect(cellValue(field, 0, 0)).toBe(1)
    expect(cellValue(field, 1, 0)).toBe(2)
  })

  it('derives latitudes north-first and longitudes west-first from the grid', () => {
    const field = decode([{ grid, values: [1, 2, 3, 4], validTime: new Date(Date.UTC(2026, 7, 31)) }])
    expect(field.latitudes[0]).toBeCloseTo(51.0, 6)
    expect(field.latitudes[1]).toBeCloseTo(50.95, 6)
    expect(field.longitudes[0]).toBeCloseTo(6.6, 6)
    expect(field.longitudes[1]).toBeCloseTo(6.65, 6)
  })

  /** Comparing a cell against another cell's history is worse than having no answer. */
  it('refuses messages that describe different grids', () => {
    const messages: Array<Grib2FixtureMessage> = [
      { grid, values: [1, 2, 3, 4], validTime: new Date(Date.UTC(2026, 7, 31)) },
      {
        grid: { ...grid, ni: 3, nj: 2 },
        values: [1, 2, 3, 4, 5, 6],
        validTime: new Date(Date.UTC(2026, 8, 1)),
      },
    ]
    expect(() => decode(messages)).toThrow(/disagree about the grid/)
  })

  it('refuses a ragged ensemble rather than comparing unequal lead times', () => {
    const messages: Array<Grib2FixtureMessage> = [
      { grid, values: [1, 0, 0, 0], validTime: new Date(Date.UTC(2026, 7, 31)), perturbationNumber: 0 },
      { grid, values: [2, 0, 0, 0], validTime: new Date(Date.UTC(2026, 7, 31)), perturbationNumber: 1 },
      { grid, values: [3, 0, 0, 0], validTime: new Date(Date.UTC(2026, 8, 1)), perturbationNumber: 0 },
    ]
    expect(() => decode(messages)).toThrow(/ragged/)
  })
})

describe('yearsForSlices', () => {
  /**
   * A `dis24` field is stamped with the *end* of the day it averages, so 31 December's mean is
   * stamped 1 January. Taking the year off the stamp would file one day of every year into the
   * next and hand its value to the wrong annual maximum.
   */
  it('attributes a field to the day it covers, not the instant it ends', () => {
    const field = decode([
      { grid, values: [1, 0, 0, 0], validTime: new Date(Date.UTC(2021, 0, 1)), productTemplate: 72 },
      { grid, values: [2, 0, 0, 0], validTime: new Date(Date.UTC(2021, 0, 2)), productTemplate: 72 },
    ])
    // The first covers 2020-12-31 and belongs to 2020; the second covers 2021-01-01.
    expect(yearsForSlices(field)).toEqual([2020, 2021])
  })

  it('repeats the year across every member of a lead time', () => {
    const field = decode([
      { grid, values: [1, 0, 0, 0], validTime: new Date(Date.UTC(2020, 5, 2)), perturbationNumber: 0 },
      { grid, values: [2, 0, 0, 0], validTime: new Date(Date.UTC(2020, 5, 2)), perturbationNumber: 1 },
    ])
    expect(yearsForSlices(field)).toEqual([2020, 2020])
  })
})

describe('gridBBox', () => {
  /**
   * The axes give cell centres and the vectoriser maps pixel zero to the box edge, so using the
   * centres shifts every zone half a cell — about 2.5 km here, a street or two of error in the
   * answer somebody would walk on.
   */
  it('returns the outer edges, half a cell beyond the centres', () => {
    const field = decode([{ grid, values: [1, 2, 3, 4], validTime: new Date(Date.UTC(2026, 7, 31)) }])
    const [west, south, east, north] = gridBBox(field, [0, 0, 0, 0])

    expect(north).toBeCloseTo(51.025, 6)
    expect(south).toBeCloseTo(50.925, 6)
    expect(west).toBeCloseTo(6.575, 6)
    expect(east).toBeCloseTo(6.675, 6)
  })
})

/** A grid built directly, for the arithmetic that does not need a file behind it. */
const fieldGrid = (options: {
  readonly sliceAxes: FieldGrid['sliceAxes']
  readonly cellCount: number
  readonly values: ReadonlyArray<number>
}): FieldGrid => ({
  latitudes: [51, 50.95],
  longitudes: [6.6],
  sliceAxes: options.sliceAxes,
  values: Float64Array.from(options.values),
  width: 1,
  height: options.cellCount,
  cellCount: options.cellCount,
  sliceCount: options.sliceAxes.reduce((product, axis) => product * axis.length, 1),
  productTemplate: 73,
})

describe('annualMaximaPerCell', () => {
  it('takes the largest value in each year, per cell', () => {
    const grid = fieldGrid({
      sliceAxes: [{ name: 'time', length: 4 }],
      cellCount: 2,
      // year 1990: [10, 5] then [3, 40];  year 1991: [20, 1] then [15, 2]
      values: [10, 5, 3, 40, 20, 1, 15, 2],
    })
    const maxima = annualMaximaPerCell([{ grid, years: [1990, 1990, 1991, 1991] }], 2)

    expect(maxima[0]).toEqual([10, 20])
    expect(maxima[1]).toEqual([40, 2])
  })

  /**
   * A year sampled from two thirds of a record has its maximum biased low, and biases the whole
   * fit with it — invisibly, because the result is still a number.
   */
  it('drops a year that is not fully represented', () => {
    const grid = fieldGrid({
      sliceAxes: [{ name: 'time', length: 3 }],
      cellCount: 1,
      values: [10, 20, 999],
    })
    const maxima = annualMaximaPerCell([{ grid, years: [1990, 1990, 1991] }], 2)
    expect(maxima[0]).toEqual([20]) // 1991 had one day of the two required
  })

  it('combines the chunked retrievals into one series', () => {
    const chunk = (value: number, year: number) => ({
      grid: fieldGrid({ sliceAxes: [{ name: 'time', length: 1 }], cellCount: 1, values: [value] }),
      years: [year],
    })
    expect(annualMaximaPerCell([chunk(5, 1990), chunk(9, 1991), chunk(7, 1992)], 1)[0]).toEqual([5, 9, 7])
  })

  it('refuses to combine retrievals that disagree on grid size', () => {
    const a = { grid: fieldGrid({ sliceAxes: [{ name: 'time', length: 1 }], cellCount: 2, values: [1, 2] }), years: [1990] }
    const b = { grid: fieldGrid({ sliceAxes: [{ name: 'time', length: 1 }], cellCount: 3, values: [1, 2, 3] }), years: [1991] }
    expect(() => annualMaximaPerCell([a, b], 1)).toThrow(/disagree on grid size/)
  })

  it('ignores missing values rather than treating them as a peak', () => {
    const grid = fieldGrid({
      sliceAxes: [{ name: 'time', length: 2 }],
      cellCount: 1,
      values: [Number.NaN, 12],
    })
    expect(annualMaximaPerCell([{ grid, years: [1990, 1990] }], 1)[0]).toEqual([12])
  })
})

describe('returnLevelsPerCell', () => {
  const risingSeries = Array.from({ length: 30 }, (_, i) => 100 + i * 5)

  it('fits a cell with a long enough record', () => {
    const [cell] = returnLevelsPerCell([risingSeries])
    expect(cell!.yearsOfRecord).toBe(30)
    expect(cell!.levels).toBeDefined()
    // Rarer floods are larger ones; anything else means the fit is upside down.
    expect(cell!.levels![5]).toBeGreaterThan(cell!.levels![2])
    expect(cell!.levels![20]).toBeGreaterThan(cell!.levels![5])
  })

  it('refuses a record too short to fit', () => {
    const short = risingSeries.slice(0, MIN_YEARS_FOR_FIT - 1)
    expect(returnLevelsPerCell([short])[0]!.levels).toBeUndefined()
  })

  /**
   * Most cells in a box are not rivers. Fitting their flat near-zero series gives a two-year level
   * near zero, which would put every hillside above its own flood the moment anything ran off it.
   */
  it('refuses a cell that carries no meaningful flow', () => {
    const dry = Array.from({ length: 30 }, (_, i) => 0.001 * i)
    expect(returnLevelsPerCell([dry])[0]!.levels).toBeUndefined()
  })

  /**
   * A flat series fits without complaining and returns 500 for every return period, so a forecast
   * of 500 would come back "extreme". A constant is not a flood frequency curve.
   */
  it('refuses a degenerate series with no spread to fit', () => {
    const flat = Array.from({ length: 30 }, () => 500)
    expect(returnLevelsPerCell([flat])[0]!.levels).toBeUndefined()
  })

  it('refuses a curve whose twenty-year flood is indistinguishable from its two-year one', () => {
    const nearlyFlat = Array.from({ length: 30 }, (_, i) => 500 + (i % 2) * 0.05)
    const [cell] = returnLevelsPerCell([nearlyFlat])
    expect(cell!.levels).toBeUndefined()
    expect(cell!.yearsOfRecord).toBe(30) // refused on the shape of the curve, not on record length
  })
})

describe('classifyForecast', () => {
  const fitted: CellThresholds = { levels: { 2: 100, 5: 200, 20: 400 }, yearsOfRecord: 30 }
  const unfitted: CellThresholds = { levels: undefined, yearsOfRecord: 3 }

  /** Four members at one lead time, over one cell. */
  const ensemble = (members: ReadonlyArray<number>): FieldGrid =>
    fieldGrid({
      sliceAxes: [
        { name: 'time', length: 1 },
        { name: 'number', length: members.length },
      ],
      cellCount: 1,
      values: members,
    })

  it('classes by the rarest level enough of the ensemble exceeds', () => {
    expect(classifyForecast(ensemble([450, 450, 50, 50]), [fitted]).cells[0]!.hazardClass).toBe('extreme')
    expect(classifyForecast(ensemble([250, 250, 50, 50]), [fitted]).cells[0]!.hazardClass).toBe('high')
    expect(classifyForecast(ensemble([150, 150, 50, 50]), [fitted]).cells[0]!.hazardClass).toBe('moderate')
    expect(classifyForecast(ensemble([50, 50, 50, 50]), [fitted]).cells[0]!.hazardClass).toBeNull()
  })

  /**
   * One member out of four is 25%, below the 30% at which EFAS and GloFAS issue their own
   * notifications. Drawing it would paint most of Europe most of the time.
   */
  it('does not draw a level a lone member touches', () => {
    const result = classifyForecast(ensemble([150, 50, 50, 50]), [fitted])
    expect(result.cells[0]!.hazardClass).toBeNull()
    expect(result.cells[0]!.probabilities[2]).toBeCloseTo(0.25, 6)
    expect(EXCEEDANCE_PROBABILITY).toBeGreaterThan(0.25)
  })

  /** A peak on day three is not made smaller by two quiet days on either side of it. */
  it('takes the worst lead time rather than averaging over the horizon', () => {
    const grid = fieldGrid({
      sliceAxes: [
        { name: 'time', length: 3 },
        { name: 'number', length: 2 },
      ],
      cellCount: 1,
      values: [10, 10, 450, 450, 10, 10],
    })
    expect(classifyForecast(grid, [fitted]).cells[0]!.hazardClass).toBe('extreme')
  })

  /** An unfitted cell is counted and reported, never drawn as a cell that will not flood. */
  it('reports cells it has no threshold for instead of calling them safe', () => {
    const grid = fieldGrid({
      sliceAxes: [
        { name: 'time', length: 1 },
        { name: 'number', length: 2 },
      ],
      cellCount: 2,
      values: [9999, 50, 9999, 50], // cell 0 is enormous, cell 1 is quiet
    })
    const result = classifyForecast(grid, [unfitted, fitted])
    expect(result.unfittedCells).toBe(1)
    expect(result.cells[0]!.hazardClass).toBeNull()
    expect(result.grid[0]).toBeNull()
  })

  it('reports how many members and lead times it actually had', () => {
    const result = classifyForecast(ensemble([450, 450, 50, 50]), [fitted])
    expect(result.memberCount).toBe(4)
    expect(result.leadCount).toBe(1)
  })

  it('ignores missing members rather than counting them as below threshold', () => {
    const grid = ensemble([450, 450, Number.NaN, Number.NaN])
    expect(classifyForecast(grid, [fitted]).cells[0]!.probabilities[20]).toBe(1)
  })
})
