/**
 * Rainfall climatology, for sizing rivers rather than forecasting storms.
 *
 * The model needs to know what flow a channel is in equilibrium with — its
 * bankfull discharge, roughly the two-year flood. Without that it has to guess
 * the cross-section from catchment area, and the hindcast measured that guess
 * wrong by two to four orders of magnitude on large rivers.
 *
 * ERA5 reanalysis gives 60+ years of daily precipitation anywhere on land, from
 * the same provider as the forecast this server already uses. An annual-maximum
 * series out of it, fitted with Gumbel, gives the local two-year rainfall, and
 * the model's existing runoff and unit-hydrograph chain turns that into a
 * discharge. No regional coefficient is invented anywhere in the path.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LonLat } from '../src/domain/geo'
import { gumbelReturnLevel } from '../src/lib/hydrology/catchment'
import type { GeoProxyService } from './geo-proxy'
import { BoundedCache } from './static-cache'

export const CLIMATE_SOURCE_ID = 'global.open-meteo.era5'
export const CLIMATE_ATTRIBUTION = 'ERA5 reanalysis via Open-Meteo (CC BY 4.0)'
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'

/** ERA5 begins in 1940; 1960 is plenty for a stable extreme-value fit. */
const FIRST_YEAR = 1960
/** Fewer than this and the Gumbel fit is not worth trusting. */
const MIN_YEARS = 20
/** Sixty-odd years of daily values is ~450 KB. */
const ARCHIVE_TIMEOUT_MS = 45_000

/**
 * Rainfall climatology, keyed to a tenth of a degree — roughly 10 km, over
 * which a 60-year extreme-value fit does not meaningfully move. Kept for a day
 * because the underlying record grows once a year.
 */
const climateCache = new BoundedCache<ClimateResult>({ maxEntries: 256, ttlMs: 24 * 60 * 60 * 1000 })

export const climateCacheStats = () => climateCache.stats

export const era5ArchiveUrl = (at: LonLat, endYear: number): string => {
  const params = new URLSearchParams({
    latitude: at.latitude.toFixed(3),
    longitude: at.longitude.toFixed(3),
    start_date: `${FIRST_YEAR}-01-01`,
    end_date: `${endYear}-12-31`,
    daily: 'precipitation_sum',
    timezone: 'UTC',
  })
  return `${ARCHIVE_URL}?${params.toString()}`
}

/** Largest one-day total in each calendar year of the record. */
export const annualMaxima = (
  times: ReadonlyArray<string>,
  values: ReadonlyArray<number | null>,
): ReadonlyArray<number> => {
  const peak = new Map<string, number>()
  const seen = new Map<string, number>()
  for (let i = 0; i < times.length; i++) {
    const value = values[i]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const year = times[i]!.slice(0, 4)
    peak.set(year, Math.max(peak.get(year) ?? 0, value))
    seen.set(year, (seen.get(year) ?? 0) + 1)
  }
  // Drop part-years, which would bias the maxima low.
  return [...peak.entries()]
    .filter(([year]) => (seen.get(year) ?? 0) >= 300)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
}

export interface ClimateResult {
  /** Two-year, one-day rainfall, mm. Zero when unavailable. */
  readonly rain2yrMm: number
  readonly yearsOfRecord: number
  readonly status: string
  /**
   * Where the series behind it came from. `stored` is the same data as
   * `archive` — the archive's own reply, kept from an earlier run — and is not
   * a degraded path; `none` means there is no series and the model is on its
   * fallback geometry.
   */
  readonly retrievedFrom: 'archive' | 'stored' | 'none'
}

/**
 * The annual-maximum series, kept on disk between runs.
 *
 * The archive's daily request cap is the binding constraint on this model:
 * one call asks for 66 years of daily values, which is heavy enough that a few
 * dozen of them exhaust the day's allowance for every caller on the machine.
 * The in-memory cache does not survive a restart, so a run of the hindcast
 * could spend the whole allowance and still not finish.
 *
 * What is stored is the annual maxima rather than the fitted return level: it
 * is 66 numbers either way, and keeping the series means a change to the
 * extreme-value fit is picked up on the next run instead of being frozen into
 * a cached answer. Nothing else about the reply is worth 450 KB.
 */
interface StoredSeries {
  readonly latitude: number
  readonly longitude: number
  readonly firstYear: number
  readonly endYear: number
  /** Largest one-day total in each complete year of the record, mm. */
  readonly annualMaximaMm: ReadonlyArray<number>
  readonly retrievedAt: string
  readonly source: string
}

/** Location to a tenth of a degree, the same resolution the in-memory cache keys on. */
const locationKey = (at: LonLat): string =>
  `${at.latitude.toFixed(1)},${at.longitude.toFixed(1)}`

const seriesPath = (dir: string, at: LonLat, endYear: number): string =>
  join(dir, `${locationKey(at).replace(',', '_')}_${FIRST_YEAR}-${endYear}.json`)

/** The stored maxima, or undefined for anything unreadable — a cache is never load-bearing. */
export const readStoredSeries = (
  dir: string,
  at: LonLat,
  endYear: number,
): ReadonlyArray<number> | undefined => {
  if (dir === '') return undefined
  try {
    const parsed = JSON.parse(readFileSync(seriesPath(dir, at, endYear), 'utf8')) as StoredSeries
    const maxima = parsed?.annualMaximaMm
    if (!Array.isArray(maxima) || maxima.length === 0) return undefined
    if (!maxima.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return undefined
    return maxima
  } catch {
    return undefined
  }
}

/**
 * Write the series, atomically and best-effort. A cache that cannot be written
 * costs a refetch; one that is half-written costs a wrong answer, so it is
 * renamed into place rather than written in place.
 */
export const writeStoredSeries = (
  dir: string,
  at: LonLat,
  endYear: number,
  annualMaximaMm: ReadonlyArray<number>,
  now = new Date(),
): void => {
  if (dir === '') return
  const record: StoredSeries = {
    latitude: at.latitude,
    longitude: at.longitude,
    firstYear: FIRST_YEAR,
    endYear,
    annualMaximaMm,
    retrievedAt: now.toISOString(),
    source: CLIMATE_SOURCE_ID,
  }
  try {
    mkdirSync(dir, { recursive: true })
    const target = seriesPath(dir, at, endYear)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(record))
    renameSync(temporary, target)
  } catch {
    // Nothing here is worth failing a flood model over.
  }
}

/** The two-year return level implied by a series, or a refusal if it is too short. */
const fitSeries = (
  maxima: ReadonlyArray<number>,
  retrievedFrom: 'archive' | 'stored',
): ClimateResult =>
  maxima.length < MIN_YEARS
    ? {
        rain2yrMm: 0,
        yearsOfRecord: maxima.length,
        status: `only ${maxima.length} complete years, need ${MIN_YEARS}`,
        retrievedFrom: 'none',
      }
    : {
        rain2yrMm: Math.round(gumbelReturnLevel(maxima, 2) * 10) / 10,
        yearsOfRecord: maxima.length,
        status: 'ok',
        retrievedFrom,
      }

/**
 * Best-effort, like every other refinement here: without it the model falls
 * back to area-keyed hydraulic geometry and says so, rather than failing.
 *
 * Three places are asked in turn, cheapest first: the in-process cache, the
 * series kept on disk from an earlier run, and only then the archive itself.
 * The archive's daily request cap makes that order the difference between a
 * validation run that finishes and one that does not.
 */
export const loadRainfallClimatology = async (
  proxy: GeoProxyService,
  at: LonLat,
  fixtureMode: boolean,
  options: { readonly cacheDir?: string; readonly now?: Date } = {},
): Promise<ClimateResult> => {
  const { cacheDir = '', now = new Date() } = options
  if (fixtureMode) {
    return { rain2yrMm: 0, yearsOfRecord: 0, status: 'fixture: no climatology', retrievedFrom: 'none' }
  }
  const key = locationKey(at)
  const cached = climateCache.get(key)
  if (cached !== undefined) return cached

  const endYear = now.getUTCFullYear() - 1
  const stored = readStoredSeries(cacheDir, at, endYear)
  if (stored !== undefined) {
    const result = fitSeries(stored, 'stored')
    if (result.status === 'ok') climateCache.set(key, result)
    return result
  }

  try {
    const res = await proxy.fetchUpstream(CLIMATE_SOURCE_ID, era5ArchiveUrl(at, endYear), {
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      maxBytes: 8 * 1024 * 1024,
    })
    if (res.status !== 200) {
      return { rain2yrMm: 0, yearsOfRecord: 0, status: `ERA5 HTTP ${res.status}`, retrievedFrom: 'none' }
    }
    const parsed = JSON.parse(res.body) as {
      daily?: { time?: ReadonlyArray<string>; precipitation_sum?: ReadonlyArray<number | null> }
    }
    const times = parsed?.daily?.time
    const values = parsed?.daily?.precipitation_sum
    if (!Array.isArray(times) || !Array.isArray(values)) {
      return { rain2yrMm: 0, yearsOfRecord: 0, status: 'ERA5 reply unreadable', retrievedFrom: 'none' }
    }
    const maxima = annualMaxima(times, values)
    const result = fitSeries(maxima, 'archive')
    if (result.status !== 'ok') return result
    // Only a good fit is worth remembering, in memory or on disk: caching an
    // outage would keep the model on its fallback long after the archive came
    // back. A series that fitted once will not need asking for again.
    climateCache.set(key, result)
    writeStoredSeries(cacheDir, at, endYear, maxima, now)
    return result
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { rain2yrMm: 0, yearsOfRecord: 0, status: `ERA5 failed: ${message}`, retrievedFrom: 'none' }
  }
}
