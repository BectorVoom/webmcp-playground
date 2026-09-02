/**
 * What to ask the store for: the run, the box, and the two dataset requests.
 *
 * Kept apart from the retrieval machinery because all of it is arithmetic on dates and degrees,
 * and arithmetic that decides which forecast run is current is worth being able to test at a fixed
 * clock rather than at whatever time the suite happens to run.
 */
import type { LonLat } from '../../src/domain/geo'

export const GLOFAS_FORECAST_DATASET = 'cems-glofas-forecast'
export const GLOFAS_HISTORICAL_DATASET = 'cems-glofas-historical'

/**
 * GloFAS is a 0.05° global grid — about 5.5 km at the equator and 3.5 km across France. Snapping
 * the requested box to it means the store returns whole cells and the returned axes line up with
 * the ones the thresholds were computed on, which is what lets a forecast cell be compared with
 * its own history rather than an interpolated neighbour.
 */
export const GLOFAS_CELL_DEGREES = 0.05

/**
 * The forecast is initialised at 00 UTC daily and reaches the store some hours later. Twelve is
 * deliberately conservative: asking for a run that has not been published yet fails the whole
 * retrieval, while asking for the previous one costs at most a few hours of freshness on a product
 * whose shortest lead time is a day.
 */
export const PUBLICATION_LAG_HOURS = 12

/**
 * Lead times retrieved, in hours.
 *
 * The dataset offers out to 720 h, and asking for all of it would multiply the retrieval by six
 * for days of a forecast nobody evacuates on. Five days is the range over which GloFAS has useful
 * skill for a flood peak and the range over which somebody can still act on it.
 */
export const FORECAST_LEAD_HOURS = [24, 48, 72, 96, 120] as const

/**
 * Years behind the thresholds. A 1991–2020 window is the standard WMO climate normal, and thirty
 * annual maxima is a defensible Gumbel fit — the same bar `server/climate-source.ts` sets for
 * rainfall, which refuses a fit below twenty.
 */
export const THRESHOLD_FIRST_YEAR = 1991
export const THRESHOLD_LAST_YEAR = 2020

/**
 * Years per historical retrieval.
 *
 * One, because the store will not take more. Measured against the live API on 2026-08-31: a
 * request for two calendar years of daily fields over a 0.8° box is refused outright with
 * `Your request is too large, please reduce your selection`, and so are three and five. One year
 * — 365 daily fields — is accepted.
 *
 * That makes a cold location thirty jobs rather than six, which is why `GlofasForecastService`
 * keeps several in the queue at once instead of walking them one at a time.
 */
export const THRESHOLD_YEARS_PER_CHUNK = 1

/** North, west, south, east — the order the store's `area` takes, which is not the bbox order. */
export type StoreArea = readonly [number, number, number, number]

const snapDown = (value: number): number => Math.floor(value / GLOFAS_CELL_DEGREES) * GLOFAS_CELL_DEGREES
const snapUp = (value: number): number => Math.ceil(value / GLOFAS_CELL_DEGREES) * GLOFAS_CELL_DEGREES

/** Rounded so that 0.1 + 0.2 arithmetic does not reach the store as 6.300000000000001. */
const tidy = (value: number): number => Math.round(value * 1e6) / 1e6

/**
 * The box to retrieve for a query, snapped outward onto the GloFAS grid.
 *
 * Outward rather than nearest, so the returned cells always cover the whole circle the user asked
 * about: a box snapped inward silently drops the outermost ring of cells, which is exactly the
 * part of a 20 km query the user can still walk out of.
 */
export const forecastArea = (at: LonLat, radiusKm: number): StoreArea => {
  const latDegrees = radiusKm / 111.32
  // Longitude degrees shrink with latitude; without the cosine a 20 km box near the Arctic circle
  // is a third of the width it should be. Clamped so the poles cannot produce an infinite span.
  const lonDegrees = radiusKm / (111.32 * Math.max(Math.cos((at.latitude * Math.PI) / 180), 0.05))

  const north = Math.min(90, tidy(snapUp(at.latitude + latDegrees)))
  const south = Math.max(-90, tidy(snapDown(at.latitude - latDegrees)))
  const west = Math.max(-180, tidy(snapDown(at.longitude - lonDegrees)))
  const east = Math.min(180, tidy(snapUp(at.longitude + lonDegrees)))

  return [north, west, south, east]
}

export interface ForecastRun {
  /** Midnight UTC of the run, as the store's date parts. */
  readonly year: string
  readonly month: string
  readonly day: string
  /** The run's initialisation time, epoch ms. */
  readonly basetime: number
}

/**
 * The most recent forecast run the store can be expected to hold.
 *
 * Note that this is a claim about publication, not about the file: if the run is late, the
 * retrieval fails and the caller falls back to the previous day rather than serving a run that
 * does not exist.
 */
export const latestForecastRun = (now: Date): ForecastRun => {
  const basetime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const published = now.getTime() - basetime >= PUBLICATION_LAG_HOURS * 3_600_000
  const run = new Date(published ? basetime : basetime - 86_400_000)

  return {
    year: String(run.getUTCFullYear()),
    month: String(run.getUTCMonth() + 1).padStart(2, '0'),
    day: String(run.getUTCDate()).padStart(2, '0'),
    basetime: run.getTime(),
  }
}

/** The run before this one, for when the latest has not been published after all. */
export const previousRun = (run: ForecastRun): ForecastRun => {
  const earlier = new Date(run.basetime - 86_400_000)
  return {
    year: String(earlier.getUTCFullYear()),
    month: String(earlier.getUTCMonth() + 1).padStart(2, '0'),
    day: String(earlier.getUTCDate()).padStart(2, '0'),
    basetime: earlier.getTime(),
  }
}

/**
 * The forecast retrieval.
 *
 * Both product types are asked for together: the control run is the single unperturbed forecast
 * and the perturbed members are what make an exceedance a probability rather than a yes or no.
 * Asking for only the control would give a discharge with no way to say how confident it is.
 */
/**
 * GRIB2 rather than NetCDF, and the choice is forced. The store's `netcdf` output is written by
 * `cfgrib` and is NetCDF-4 — HDF5 underneath, needing a library to read. Its GRIB2 output for the
 * same request is a regular lat/lon grid with simple packing, which `grib2.ts` reads directly.
 */
export const forecastRequest = (run: ForecastRun, area: StoreArea): Record<string, unknown> => ({
  system_version: ['operational'],
  hydrological_model: ['lisflood'],
  product_type: ['control_forecast', 'ensemble_perturbed_forecasts'],
  variable: 'river_discharge_in_the_last_24_hours',
  year: [run.year],
  month: [run.month],
  day: [run.day],
  leadtime_hour: FORECAST_LEAD_HOURS.map(String),
  data_format: 'grib2',
  // Unarchived, because a zip would have to be unpacked before the NetCDF reader ever sees it.
  download_format: 'unarchived',
  area,
})

const monthsOfYear = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
const daysOfMonth = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))

/**
 * The historical retrievals behind the thresholds, one per chunk of years.
 *
 * `consolidated` rather than `intermediate`: the consolidated stream is the finished reanalysis,
 * and a return level fitted partly on provisional data would move under the model as the store
 * caught up.
 */
export const thresholdRequests = (
  area: StoreArea,
  firstYear = THRESHOLD_FIRST_YEAR,
  lastYear = THRESHOLD_LAST_YEAR,
  yearsPerChunk = THRESHOLD_YEARS_PER_CHUNK,
): ReadonlyArray<{ readonly years: ReadonlyArray<string>; readonly inputs: Record<string, unknown> }> => {
  const chunks: Array<{ years: ReadonlyArray<string>; inputs: Record<string, unknown> }> = []

  for (let start = firstYear; start <= lastYear; start += yearsPerChunk) {
    const years: Array<string> = []
    for (let year = start; year < start + yearsPerChunk && year <= lastYear; year++) {
      years.push(String(year))
    }
    chunks.push({
      years,
      inputs: {
        system_version: ['version_4_0'],
        hydrological_model: ['lisflood'],
        product_type: ['consolidated'],
        timespan: ['time_mean'],
        variable: ['average_river_discharge_in_the_last_24_hours'],
        year: years,
        month: monthsOfYear,
        // The store ignores the days a month does not have rather than rejecting the request.
        day: daysOfMonth,
        data_format: 'grib2',
        download_format: 'unarchived',
        area,
      },
    })
  }

  return chunks
}

/**
 * Location key, to a tenth of a degree.
 *
 * The same resolution `climate-source.ts` keys its rainfall climatology at, and for the same
 * reason: two queries 5 km apart want the same box of cells, and giving each its own retrieval
 * would multiply the slowest thing here by the number of times somebody panned the map.
 */
export const locationKey = (at: LonLat): string =>
  `${at.latitude.toFixed(1)}_${at.longitude.toFixed(1)}`
