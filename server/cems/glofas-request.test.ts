import { describe, expect, it } from 'vitest'
import {
  FORECAST_LEAD_HOURS,
  forecastArea,
  forecastRequest,
  GLOFAS_CELL_DEGREES,
  latestForecastRun,
  locationKey,
  previousRun,
  PUBLICATION_LAG_HOURS,
  thresholdRequests,
  THRESHOLD_FIRST_YEAR,
  THRESHOLD_LAST_YEAR,
} from './glofas-request'

const cologne = { latitude: 50.94, longitude: 6.96 }

describe('latestForecastRun', () => {
  /**
   * Before the publication lag has elapsed the run exists but the file does not, and asking for it
   * fails the whole retrieval. Yesterday's run is a few hours older and actually there.
   */
  it('holds back to the previous run until the lag has elapsed', () => {
    const justBefore = new Date(Date.UTC(2026, 7, 31, PUBLICATION_LAG_HOURS - 1))
    expect(latestForecastRun(justBefore)).toMatchObject({ year: '2026', month: '08', day: '30' })
  })

  it('moves to today once the lag has elapsed', () => {
    const justAfter = new Date(Date.UTC(2026, 7, 31, PUBLICATION_LAG_HOURS))
    expect(latestForecastRun(justAfter)).toMatchObject({ year: '2026', month: '08', day: '31' })
  })

  it('steps back across a month boundary without producing day zero', () => {
    const firstOfMonth = new Date(Date.UTC(2026, 8, 1, 0))
    expect(latestForecastRun(firstOfMonth)).toMatchObject({ year: '2026', month: '08', day: '31' })
  })

  it('steps back across a year boundary', () => {
    const newYear = new Date(Date.UTC(2026, 0, 1, 0))
    expect(latestForecastRun(newYear)).toMatchObject({ year: '2025', month: '12', day: '31' })
  })

  it('names the run before a given one', () => {
    const run = latestForecastRun(new Date(Date.UTC(2026, 2, 1, 23)))
    expect(run).toMatchObject({ month: '03', day: '01' })
    expect(previousRun(run)).toMatchObject({ month: '02', day: '28' })
  })
})

describe('forecastArea', () => {
  it('returns north, west, south, east — not bbox order', () => {
    const [north, west, south, east] = forecastArea(cologne, 20)
    expect(north).toBeGreaterThan(south)
    expect(east).toBeGreaterThan(west)
    expect(north).toBeGreaterThan(cologne.latitude)
    expect(south).toBeLessThan(cologne.latitude)
  })

  it('snaps every edge onto the GloFAS grid', () => {
    for (const edge of forecastArea(cologne, 17.3)) {
      const steps = edge / GLOFAS_CELL_DEGREES
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6)
    }
  })

  /**
   * Outward, never inward. A box snapped to the nearest cell drops the outermost ring, which is
   * the part of a 20 km query somebody can still walk into.
   */
  it('always covers the whole requested circle', () => {
    const radiusKm = 20
    const [north, west, south, east] = forecastArea(cologne, radiusKm)
    const latDegrees = radiusKm / 111.32
    const lonDegrees = latDegrees / Math.cos((cologne.latitude * Math.PI) / 180)

    expect(north).toBeGreaterThanOrEqual(cologne.latitude + latDegrees)
    expect(south).toBeLessThanOrEqual(cologne.latitude - latDegrees)
    expect(east).toBeGreaterThanOrEqual(cologne.longitude + lonDegrees)
    expect(west).toBeLessThanOrEqual(cologne.longitude - lonDegrees)
  })

  /** Longitude degrees shrink towards the pole; without the cosine a northern box is too narrow. */
  it('widens the longitude span at high latitude', () => {
    const [, westSouth, , eastSouth] = forecastArea({ latitude: 0, longitude: 10 }, 20)
    const [, westNorth, , eastNorth] = forecastArea({ latitude: 68, longitude: 10 }, 20)
    expect(eastNorth - westNorth).toBeGreaterThan(eastSouth - westSouth)
  })

  it('does not run off the ends of the coordinate system', () => {
    const [north, west, south, east] = forecastArea({ latitude: 89.9, longitude: 179.9 }, 50)
    expect(north).toBeLessThanOrEqual(90)
    expect(south).toBeGreaterThanOrEqual(-90)
    expect(east).toBeLessThanOrEqual(180)
    expect(west).toBeGreaterThanOrEqual(-180)
  })
})

describe('forecastRequest', () => {
  it('asks for the control run and the perturbed members together', () => {
    const request = forecastRequest(latestForecastRun(new Date(Date.UTC(2026, 7, 31, 18))), [51, 6.5, 50.5, 7.5])
    expect(request.product_type).toEqual(['control_forecast', 'ensemble_perturbed_forecasts'])
    expect(request.leadtime_hour).toEqual(FORECAST_LEAD_HOURS.map(String))
    // A zip would have to be unpacked before the reader ever saw it.
    expect(request.download_format).toBe('unarchived')
    // Not netcdf: the store's netcdf output is NetCDF-4/HDF5, which needs a library to read.
    expect(request.data_format).toBe('grib2')
  })

  it('asks for the history in the same format as the forecast', () => {
    for (const chunk of thresholdRequests([51, 6.5, 50.5, 7.5])) {
      expect(chunk.inputs.data_format).toBe('grib2')
      expect(chunk.inputs.download_format).toBe('unarchived')
    }
  })
})

describe('thresholdRequests', () => {
  it('covers the whole window in chunks', () => {
    const chunks = thresholdRequests([51, 6.5, 50.5, 7.5])
    const years = chunks.flatMap((chunk) => chunk.years)

    expect(years[0]).toBe(String(THRESHOLD_FIRST_YEAR))
    expect(years[years.length - 1]).toBe(String(THRESHOLD_LAST_YEAR))
    expect(new Set(years).size).toBe(years.length) // no year retrieved twice
    expect(years).toHaveLength(THRESHOLD_LAST_YEAR - THRESHOLD_FIRST_YEAR + 1)
  })

  it('does not overrun the last year when the window is not a whole number of chunks', () => {
    const chunks = thresholdRequests([51, 6.5, 50.5, 7.5], 2000, 2007, 5)
    expect(chunks.map((c) => c.years)).toEqual([
      ['2000', '2001', '2002', '2003', '2004'],
      ['2005', '2006', '2007'],
    ])
  })

  /** Provisional data would move the fitted return level under the model as the store caught up. */
  it('asks for the consolidated reanalysis rather than the intermediate stream', () => {
    const [chunk] = thresholdRequests([51, 6.5, 50.5, 7.5])
    expect(chunk!.inputs.product_type).toEqual(['consolidated'])
  })
})

describe('locationKey', () => {
  it('gives two nearby queries the same key, so they share one retrieval', () => {
    expect(locationKey({ latitude: 50.94, longitude: 6.96 })).toBe(
      locationKey({ latitude: 50.941, longitude: 6.958 }),
    )
  })

  it('separates places that are genuinely apart', () => {
    expect(locationKey({ latitude: 50.94, longitude: 6.96 })).not.toBe(
      locationKey({ latitude: 51.44, longitude: 6.96 }),
    )
  })

  it('does not collide across the equator or the meridian', () => {
    expect(locationKey({ latitude: 0.04, longitude: 0.04 })).not.toBe(
      locationKey({ latitude: -0.04, longitude: -0.04 }),
    )
  })
})
