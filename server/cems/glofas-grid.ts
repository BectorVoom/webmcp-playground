/**
 * From a retrieved file to a hazard class per cell.
 *
 * Three steps live here, and all three are pure so they can be tested without the store:
 *
 *  1. `fieldGridFromMessages` — a GRIB2 retrieval's messages as a stack of lat/lon slices.
 *  2. `annualMaximaPerCell` / `returnLevelsPerCell` — thirty years of daily discharge as the
 *     two-, five- and twenty-year flood at each cell.
 *  3. `classifyForecast` — a forecast ensemble against those levels, as hazard classes.
 *
 * The reason step 2 exists at all is that a discharge is not a hazard. 800 m³/s is an ordinary
 * Tuesday on the Rhine and a catastrophe on the Ouse, and there is no way to tell which from the
 * number. What makes it meaningful is the local flood frequency curve, so the model is asked for
 * its own history at the same cells and the forecast is scored against that.
 */
import { gumbelReturnLevel } from '../../src/lib/hydrology/catchment'
import type { BBox } from '../../src/domain/geo'
import type { HazardClass } from '../../src/domain/hazard'
import { Grib2Error, type Grib2Grid, type Grib2Message } from './grib2'

/** The ensemble axis, named as GRIB2's perturbation number rather than as a file variable. */
const MEMBER_AXIS = 'number'
const TIME_AXIS = 'time'

/** The mean interval of the `dis24` products this pipeline requests. */
const MEAN_INTERVAL_MS = 24 * 3_600_000

export interface SliceAxis {
  readonly name: string
  readonly length: number
  /** The axis's own coordinate values: epoch milliseconds for time, member ids for the ensemble. */
  readonly values?: ReadonlyArray<number>
}

export interface FieldGrid {
  /** Ordered north to south, matching the row order the vectoriser expects. */
  readonly latitudes: ReadonlyArray<number>
  /** Ordered west to east. */
  readonly longitudes: ReadonlyArray<number>
  /** The axes above lat/lon, outermost first. Their product is the slice count. */
  readonly sliceAxes: ReadonlyArray<SliceAxis>
  /** Row-major within a slice: `values[slice * cellCount + row * width + column]`. */
  readonly values: Float64Array
  readonly width: number
  readonly height: number
  readonly cellCount: number
  readonly sliceCount: number
  /** Which GRIB2 product template the messages carried, so a surprising one can be seen. */
  readonly productTemplate: number
}

const sameGrid = (a: Grib2Grid, b: Grib2Grid): boolean =>
  a.ni === b.ni &&
  a.nj === b.nj &&
  Math.abs(a.lat1 - b.lat1) < 1e-6 &&
  Math.abs(a.lon1 - b.lon1) < 1e-6 &&
  Math.abs(a.di - b.di) < 1e-9 &&
  Math.abs(a.dj - b.dj) < 1e-9

/**
 * The axes a GRIB2 file describes, from the messages themselves.
 *
 * A GRIB2 file has no axes — it is a flat pile of independent fields, each stamped with the time
 * it covers and, for an ensemble, which member it is. The axes are recovered by grouping on those
 * stamps rather than by trusting the order the messages arrive in, because nothing in the format
 * promises an order and a wrongly assumed one silently pairs a member with another member's
 * forecast.
 */
export const fieldGridFromMessages = (messages: ReadonlyArray<Grib2Message>): FieldGrid => {
  if (messages.length === 0) throw new Grib2Error('the retrieval contained no messages')

  const first = messages[0]!
  for (const message of messages) {
    if (!sameGrid(message.grid, first.grid)) {
      throw new Grib2Error(
        `messages disagree about the grid: ${first.grid.ni}×${first.grid.nj} at ${first.grid.lat1},` +
          `${first.grid.lon1} against ${message.grid.ni}×${message.grid.nj} at ${message.grid.lat1},` +
          `${message.grid.lon1}`,
      )
    }
  }

  const times = [...new Set(messages.map((m) => m.validTime))].sort((a, b) => a - b)
  const byTime = new Map<number, Array<Grib2Message>>()
  for (const message of messages) {
    const group = byTime.get(message.validTime) ?? []
    group.push(message)
    byTime.set(message.validTime, group)
  }

  // Sorted by member id so slice order is the file's content rather than its byte order.
  for (const group of byTime.values()) {
    group.sort((a, b) => (a.perturbationNumber ?? 0) - (b.perturbationNumber ?? 0))
  }

  const memberCount = byTime.get(times[0]!)!.length
  for (const [time, group] of byTime) {
    if (group.length !== memberCount) {
      throw new Grib2Error(
        `the ensemble is ragged: ${memberCount} members at ${new Date(times[0]!).toISOString()} but ` +
          `${group.length} at ${new Date(time).toISOString()}, so no lead time could be compared ` +
          'with another',
      )
    }
  }

  const { ni: width, nj: height } = first.grid
  const cellCount = width * height
  const values = new Float64Array(times.length * memberCount * cellCount)

  times.forEach((time, timeIndex) => {
    byTime.get(time)!.forEach((message, memberIndex) => {
      values.set(message.values, (timeIndex * memberCount + memberIndex) * cellCount)
    })
  })

  // GRIB2 gives the first point and the increments; the axes follow from them. `orient` in the
  // reader has already normalised every message to north-first, west-first, so the latitude axis
  // descends by construction whatever the message's own scanning mode was.
  const north = Math.max(first.grid.lat1, first.grid.lat2)
  const west = Math.min(first.grid.lon1, first.grid.lon2)
  const latitudes = Array.from({ length: height }, (_, row) => north - row * first.grid.dj)
  const longitudes = Array.from({ length: width }, (_, column) => west + column * first.grid.di)

  const sliceAxes: Array<SliceAxis> = [
    { name: TIME_AXIS, length: times.length, values: times },
    { name: MEMBER_AXIS, length: memberCount, values: byTime.get(times[0]!)!.map((m, i) => m.perturbationNumber ?? i) },
  ]

  return {
    latitudes,
    longitudes,
    sliceAxes,
    values,
    width,
    height,
    cellCount,
    sliceCount: times.length * memberCount,
    productTemplate: first.productTemplate,
  }
}

/**
 * The calendar year each time slice belongs to.
 *
 * A `dis24` field is stamped with the *end* of the day it averages, so the mean for 31 December
 * carries a valid time of 1 January. Taking the year off that stamp directly would file one day of
 * every year into the next one and hand its value to the wrong annual maximum, so the interval is
 * subtracted first.
 */
export const yearsForSlices = (grid: FieldGrid): ReadonlyArray<number> | undefined => {
  const timeAxis = grid.sliceAxes.find((axis) => axis.name === TIME_AXIS)
  if (timeAxis?.values === undefined) return undefined

  const memberCount = grid.sliceCount / timeAxis.length
  const years: Array<number> = []
  for (const validTime of timeAxis.values) {
    const year = new Date(validTime - MEAN_INTERVAL_MS).getUTCFullYear()
    for (let member = 0; member < memberCount; member++) years.push(year)
  }
  return years
}

/** The value of one cell in one slice. */
export const cellValue = (grid: FieldGrid, slice: number, cell: number): number =>
  grid.values[slice * grid.cellCount + cell]!

/**
 * The grid's outer edges, as a bounding box.
 *
 * The axes give cell *centres*, and the vectoriser maps pixel index zero to the box's edge. Using
 * the centres directly would therefore shift every zone half a cell north-west and shrink the
 * whole grid by one cell — about 2.5 km at this resolution, which is a street or two of error in
 * exactly the answer people would walk on.
 */
export const gridBBox = (grid: FieldGrid, fallback: BBox): BBox => {
  const { latitudes, longitudes } = grid
  if (latitudes.length < 2 || longitudes.length < 2) return fallback

  const latStep = Math.abs(latitudes[1]! - latitudes[0]!) / 2
  const lonStep = Math.abs(longitudes[1]! - longitudes[0]!) / 2

  return [
    longitudes[0]! - lonStep,
    latitudes[latitudes.length - 1]! - latStep,
    longitudes[longitudes.length - 1]! + lonStep,
    latitudes[0]! + latStep,
  ]
}

/**
 * Converts a CF time axis to years.
 *
 * The units string is the only thing that says what the numbers mean — `days since 1979-01-01` and
 * `hours since 1970-01-01` both appear in these products, and reading one as the other misfiles
 * every value by decades, which shows up as a Gumbel fit over an implausible number of years
 * rather than as an error.
 */
export const yearsFromTimeAxis = (
  values: ReadonlyArray<number>,
  units: string | undefined,
): ReadonlyArray<number> | undefined => {
  if (units === undefined) return undefined
  const match = /^(seconds|minutes|hours|days)\s+since\s+(\d{4})-(\d{2})-(\d{2})/i.exec(units.trim())
  if (!match) return undefined

  const perUnitMs = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[
    match[1]!.toLowerCase()
  ]!
  const epoch = Date.UTC(Number(match[2]), Number(match[3]) - 1, Number(match[4]))

  return values.map((value) => new Date(epoch + value * perUnitMs).getUTCFullYear())
}

/**
 * The largest daily discharge in each year, per cell.
 *
 * Part-years are dropped for the same reason `climate-source.ts` drops them: a year represented by
 * two hundred days has had its maximum sampled from two thirds of a record, which biases the whole
 * fit low and does so invisibly.
 */
export const annualMaximaPerCell = (
  grids: ReadonlyArray<{ readonly grid: FieldGrid; readonly years: ReadonlyArray<number> }>,
  minimumDaysPerYear = 300,
): ReadonlyArray<ReadonlyArray<number>> => {
  const first = grids[0]?.grid
  if (first === undefined) return []

  const peaks = new Map<number, Float64Array>()
  const counts = new Map<number, number>()

  for (const { grid, years } of grids) {
    if (grid.cellCount !== first.cellCount) {
      throw new Grib2Error(
        `retrievals disagree on grid size: ${grid.cellCount} cells against ${first.cellCount}`,
      )
    }
    for (let slice = 0; slice < grid.sliceCount; slice++) {
      const year = years[slice]
      if (year === undefined) continue

      let peak = peaks.get(year)
      if (peak === undefined) {
        peak = new Float64Array(grid.cellCount).fill(Number.NEGATIVE_INFINITY)
        peaks.set(year, peak)
      }
      counts.set(year, (counts.get(year) ?? 0) + 1)

      for (let cell = 0; cell < grid.cellCount; cell++) {
        const value = cellValue(grid, slice, cell)
        if (Number.isFinite(value) && value > peak[cell]!) peak[cell] = value
      }
    }
  }

  const completeYears = [...peaks.keys()]
    .filter((year) => (counts.get(year) ?? 0) >= minimumDaysPerYear)
    .sort((a, b) => a - b)

  const perCell: Array<Array<number>> = Array.from({ length: first.cellCount }, () => [])
  for (const year of completeYears) {
    const peak = peaks.get(year)!
    for (let cell = 0; cell < first.cellCount; cell++) {
      const value = peak[cell]!
      if (Number.isFinite(value)) perCell[cell]!.push(value)
    }
  }
  return perCell
}

/** The return periods a forecast is scored against, and the classes they map to. */
export const RETURN_PERIODS = [2, 5, 20] as const
export type ReturnPeriod = (typeof RETURN_PERIODS)[number]

export interface CellThresholds {
  /** Discharge, m³/s, at each return period; `undefined` where the fit was refused. */
  readonly levels: Readonly<Record<ReturnPeriod, number>> | undefined
  readonly yearsOfRecord: number
}

/** Fewer than this and the fit is not worth trusting, matching the rainfall climatology's bar. */
export const MIN_YEARS_FOR_FIT = 20

/**
 * How much larger the twenty-year flood must be than the two-year one for the fit to mean
 * anything, as a fraction. Below this the curve is flat and the cell has no flood signal to score
 * a forecast against.
 */
export const MIN_RETURN_LEVEL_SEPARATION = 0.01

/**
 * Fits each cell's own flood frequency curve.
 *
 * A cell that is not a river — most of them — has a flat, near-zero series, and its two-year level
 * comes out near zero too. Left alone that makes every hillside "above its two-year flood" the
 * moment the model puts a millimetre of runoff through it, so cells whose own history never
 * carries meaningful flow are refused a fit rather than given a meaningless one.
 */
export const returnLevelsPerCell = (
  maximaPerCell: ReadonlyArray<ReadonlyArray<number>>,
  minimumBankfullM3PerS = 1,
): ReadonlyArray<CellThresholds> =>
  maximaPerCell.map((maxima) => {
    if (maxima.length < MIN_YEARS_FOR_FIT) {
      return { levels: undefined, yearsOfRecord: maxima.length }
    }
    const median = [...maxima].sort((a, b) => a - b)[Math.floor(maxima.length / 2)]!
    if (median < minimumBankfullM3PerS) {
      return { levels: undefined, yearsOfRecord: maxima.length }
    }
    try {
      const levels = {
        2: gumbelReturnLevel(maxima, 2),
        5: gumbelReturnLevel(maxima, 5),
        20: gumbelReturnLevel(maxima, 20),
      }
      /**
       * A series with no spread fits without complaining, and returns the same number for every
       * return period. That is not a flood frequency curve — it is a constant, and comparing a
       * forecast against it classes a cell "extreme" the moment it rounds upward. A twenty-year
       * flood within one per cent of the two-year flood is such a cell whatever produced it.
       */
      const separation = (levels[20] - levels[2]) / Math.max(levels[2], Number.EPSILON)
      if (!(separation >= MIN_RETURN_LEVEL_SEPARATION)) {
        return { levels: undefined, yearsOfRecord: maxima.length }
      }
      return { levels, yearsOfRecord: maxima.length }
    } catch {
      // Too short, or otherwise unfittable. Not a hazard statement either way.
      return { levels: undefined, yearsOfRecord: maxima.length }
    }
  })

/**
 * The share of the ensemble that must exceed a level before it is drawn.
 *
 * Thirty per cent is the probability at which EFAS and GloFAS issue their own formal
 * notifications. Drawing every level any single member touches would paint most of Europe most of
 * the time, and drawing only what the whole ensemble agrees on would say nothing until it was too
 * late to act.
 */
export const EXCEEDANCE_PROBABILITY = 0.3

export interface CellForecast {
  readonly hazardClass: HazardClass | null
  /** Share of members exceeding each level, at the lead time where it is largest. */
  readonly probabilities: Readonly<Record<ReturnPeriod, number>>
  /** Largest ensemble-median discharge across the lead times, m³/s. */
  readonly peakMedianM3PerS: number
}

export interface ClassifiedForecast {
  readonly cells: ReadonlyArray<CellForecast>
  readonly grid: Array<HazardClass | null>
  /** Cells with no usable threshold, which are reported rather than drawn as safe. */
  readonly unfittedCells: number
  readonly memberCount: number
  readonly leadCount: number
}

/**
 * Scores a forecast ensemble against each cell's thresholds.
 *
 * The exceedance is taken at the *worst* lead time rather than averaged over them: the question is
 * whether a flood is coming within the horizon, and a peak on day three is not made smaller by two
 * quiet days on either side of it.
 */
export const classifyForecast = (
  grid: FieldGrid,
  thresholds: ReadonlyArray<CellThresholds>,
  probabilityThreshold = EXCEEDANCE_PROBABILITY,
): ClassifiedForecast => {
  const memberAxis = grid.sliceAxes.findIndex((axis) => axis.name === MEMBER_AXIS)
  const memberCount = memberAxis === -1 ? 1 : grid.sliceAxes[memberAxis]!.length
  const leadCount = memberCount === 0 ? grid.sliceCount : grid.sliceCount / Math.max(memberCount, 1)

  /**
   * Slice indices grouped by lead time. Rather than assume whether the ensemble axis is inside or
   * outside the time axis — the products differ, and both orders decode without complaint — the
   * grouping is derived from the axis positions the file actually declares.
   */
  const strideOf = (axisIndex: number): number =>
    grid.sliceAxes.slice(axisIndex + 1).reduce((product, axis) => product * axis.length, 1)

  const memberStride = memberAxis === -1 ? 0 : strideOf(memberAxis)
  const groups: Array<Array<number>> = []
  for (let slice = 0; slice < grid.sliceCount; slice++) {
    // Which lead this slice belongs to: its index with the member axis factored out.
    const lead =
      memberAxis === -1
        ? slice
        : Math.floor(slice / (memberStride * memberCount)) * memberStride + (slice % memberStride)
    ;(groups[lead] ??= []).push(slice)
  }

  const cells: Array<CellForecast> = []
  const classes: Array<HazardClass | null> = new Array(grid.cellCount).fill(null)
  let unfittedCells = 0

  for (let cell = 0; cell < grid.cellCount; cell++) {
    const levels = thresholds[cell]?.levels
    if (levels === undefined) {
      unfittedCells++
      cells.push({ hazardClass: null, probabilities: { 2: 0, 5: 0, 20: 0 }, peakMedianM3PerS: Number.NaN })
      continue
    }

    const best: Record<ReturnPeriod, number> = { 2: 0, 5: 0, 20: 0 }
    let peakMedian = Number.NEGATIVE_INFINITY

    for (const slices of groups) {
      if (slices === undefined || slices.length === 0) continue
      const values = slices
        .map((slice) => cellValue(grid, slice, cell))
        .filter((value) => Number.isFinite(value))
      if (values.length === 0) continue

      values.sort((a, b) => a - b)
      peakMedian = Math.max(peakMedian, values[Math.floor(values.length / 2)]!)

      for (const period of RETURN_PERIODS) {
        const exceeding = values.filter((value) => value >= levels[period]).length
        best[period] = Math.max(best[period], exceeding / values.length)
      }
    }

    const hazardClass: HazardClass | null =
      best[20] >= probabilityThreshold
        ? 'extreme'
        : best[5] >= probabilityThreshold
          ? 'high'
          : best[2] >= probabilityThreshold
            ? 'moderate'
            : null

    classes[cell] = hazardClass
    cells.push({
      hazardClass,
      probabilities: best,
      peakMedianM3PerS: Number.isFinite(peakMedian) ? peakMedian : Number.NaN,
    })
  }

  return { cells, grid: classes, unfittedCells, memberCount, leadCount }
}

