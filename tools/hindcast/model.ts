/**
 * Asking the route for a run, and refusing the ones that are not comparable.
 *
 * Four of this model's inputs are best-effort — the ERA5 climatology, mapped
 * embankments, mapped standing water, and mapped infrastructure — and all four
 * degrade silently: the route answers 200 with a quietly different model behind
 * it. Each has a guard here, and a run that trips one is refused rather than
 * scored.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HindcastEvent } from './events'
import type { Observed } from './observed'
import { geometryToPolygons, totalAreaKm2, type Polygon } from './geometry'

export const DEFAULT_BASE_URL = process.env.FLOOD_MODEL_URL ?? 'http://localhost:9090'

/** Anything the route accepts; a config is a partial override of the defaults. */
export type ModelConfig = Record<string, unknown>

export interface ModelZone {
  readonly hazardClass: 'low' | 'moderate' | 'high' | 'extreme'
  readonly depth?: { readonly minMetres: number; readonly maxMetres?: number }
  readonly geometry: { type: string; coordinates: unknown }
}

export interface Component {
  readonly polygons: ReadonlyArray<Polygon>
  readonly classes: ReadonlyArray<string>
}

export interface ModelRun {
  readonly polygons: ReadonlyArray<Polygon>
  /** Hazard class of each polygon, parallel to `polygons`. */
  readonly classes: ReadonlyArray<string>
  /** Present only when the request asked for `componentZones`. */
  readonly pluvial: Component | null
  readonly fluvial: Component | null
  /** The fluvial field under ladder-pegged reaches only; subset of `fluvial`. */
  readonly fluvialPegged: Component | null
  readonly floodedAreaKm2: number
  readonly polygonAreaKm2: number
  /** Polygon area over reported grid area. Drift means the vectorisation moved. */
  readonly polyGridRatio: number
  readonly response: Record<string, unknown>
}

const num = (value: unknown): number => (typeof value === 'number' ? value : NaN)

const RUN_CACHE_DIR = join('.cache', 'hindcast', 'runs')

/**
 * Responses are kept on disk and reused. Analysis is iterated far more often
 * than the model changes, and a 20 km run is minutes of work.
 *
 * HINDCAST_REFRESH=1 to re-ask; delete the directory after changing the model,
 * because nothing here can tell that the code moved.
 */
const cacheKey = (event: HindcastEvent, body: Record<string, unknown>): string => {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)
  return join(RUN_CACHE_DIR, `${event.id}-${digest}.json`)
}

/**
 * Embankment coverage is best-effort in exactly the way the climatology is:
 * Overpass returns 504 under load and the route then reports the floodplain as
 * undefended, which is 18.5 km² of extent at Joso. A sweep that silently varies
 * whether levees existed is not a sweep. Same rule as the climatology: refuse
 * rather than score.
 */
const assertLeveesReal = (event: HindcastEvent, response: Record<string, unknown>): void => {
  const defences = response.defences as Record<string, unknown> | undefined
  if (defences?.status !== 'ok') {
    throw new Error(
      `${event.id}: embankment lookup returned "${String(defences?.status)}". ` +
        'A run with no defences is not comparable with one that had them, so it is refused ' +
        'rather than scored; if Overpass is rate-limiting, waiting is the only cure.',
    )
  }
}

/**
 * The measurement hazard from round seven: when the ERA5 archive call fails the
 * route falls back to area-keyed hydraulic geometry, which moves scored extent
 * ~2% and IoU ~0.3 points. Two runs are not comparable unless both report `ok`,
 * so a fallback is refused rather than scored.
 */
const assertClimatologyReal = (event: HindcastEvent, response: Record<string, unknown>): void => {
  const climatology = response.climatology as Record<string, unknown> | undefined
  const status = climatology?.status
  const from = climatology?.retrievedFrom
  const rain = num(climatology?.twoYearDailyRainfallMm)
  if (status !== 'ok' || from === 'none' || !(rain > 0)) {
    throw new Error(
      `${event.id}: climatology fell back (status=${String(status)}, from=${String(from)}). ` +
        'Warm the site first; a fallback run is not comparable with the recorded baselines.',
    )
  }
}

/**
 * Standing water is fetched from the same Overpass that serves the embankments,
 * degrades the same silent way, and is worth about four points of precision —
 * so it needs the same guard. A run whose water lookup failed reports every lake
 * in the window as flood and is not comparable with one that did not; it cost
 * this round a whole measurement pass before the check existed.
 *
 * A request that deliberately turns masking off is not a failure, so 'disabled
 * by request' passes.
 */
const assertWaterReal = (event: HindcastEvent, response: Record<string, unknown>): void => {
  const water = response.permanentWater as Record<string, unknown> | undefined
  const status = water?.status
  if (status === undefined) return // predates the field; nothing to check
  if (typeof status === 'string' && status.startsWith('disabled')) return
  if (status !== 'ok') {
    throw new Error(
      `${event.id}: standing-water lookup returned "${String(status)}". A run that reports ` +
        'lakes as flood is not comparable with one that does not, so it is refused rather ' +
        'than scored; if Overpass is rate-limiting, waiting is the only cure.',
    )
  }
}

/**
 * Infrastructure degrades to an empty or capped OSM layer while still returning
 * HTTP 200. That changes all three processes this harness is now measuring, so
 * an old cached response (no field), a fixture response, and a partial lookup
 * must all be refused. A deliberately disabled layer remains comparable.
 */
const assertInfrastructureReal = (event: HindcastEvent, response: Record<string, unknown>): void => {
  const infrastructure = response.infrastructure as Record<string, unknown> | undefined
  const status = infrastructure?.status
  if (typeof status === 'string' && status.startsWith('disabled')) return
  if (status !== 'ok' || infrastructure?.truncated === true) {
    throw new Error(
      `${event.id}: infrastructure lookup returned "${String(status)}". A capped, failed, ` +
        'fixture, or pre-feature response is not evidence of infrastructure precision, so it is ' +
        'refused rather than scored.',
    )
  }
}

/**
 * Overpass rate-limits hard and its circuit breaker needs time to close, so the
 * ladder runs to several minutes. Static-source results are cached, and the
 * infrastructure loader also persists successful subdivisions, but a failed
 * child still needs this wait before it can resume.
 */
const LEVEE_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000, 300_000]

const withStaticSourceRetry = async (
  event: HindcastEvent,
  requireLevees: boolean,
  attempt: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  let last: unknown
  for (let i = 0; i <= LEVEE_RETRY_DELAYS_MS.length; i++) {
    const body = await attempt()
    try {
      if (requireLevees) assertLeveesReal(event, body)
      assertWaterReal(event, body)
      assertInfrastructureReal(event, body)
      return body
    } catch (err) {
      last = err
      const delay = LEVEE_RETRY_DELAYS_MS[i]
      if (delay === undefined) break
      console.warn(`  ${event.id}: ${(err as Error).message} retrying in ${delay / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw last
}

/**
 * Runs one event through the route and returns its extent as polygons.
 *
 * The request is the event's own storm at the centroid of its surveyed extent;
 * `config` overrides anything on top of that, which is what a sweep varies.
 */
export const runModel = async (
  site: Observed,
  config: ModelConfig = {},
  baseUrl: string = DEFAULT_BASE_URL,
  options: { requireLevees?: boolean } = {},
): Promise<ModelRun> => {
  const { requireLevees = true } = options
  const { event } = site

  const requestBody: Record<string, unknown> = {
    at: { latitude: site.centre.latitude, longitude: site.centre.longitude },
    radiusKm: event.radiusKm,
    rainfallMm: event.rainfallMm,
    durationHours: event.durationHours,
    ...config,
  }

  const path = cacheKey(event, requestBody)
  let body: Record<string, unknown>

  if (process.env.HINDCAST_REFRESH !== '1' && existsSync(path)) {
    body = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } else {
    body = await withStaticSourceRetry(event, requireLevees, async () => {
      const res = await fetch(`${baseUrl}/api/geo/flood-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      const parsed = (await res.json()) as Record<string, unknown>
      if (!res.ok) {
        throw new Error(`${event.id}: route answered ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`)
      }
      assertClimatologyReal(event, parsed)
      return parsed
    })
    await mkdir(RUN_CACHE_DIR, { recursive: true })
    await writeFile(path, JSON.stringify(body))
  }
  assertClimatologyReal(event, body)
  if (requireLevees) assertLeveesReal(event, body)
  assertWaterReal(event, body)
  assertInfrastructureReal(event, body)

  const inundation = body.inundation as Record<string, unknown>
  const flatten = (zones: ReadonlyArray<ModelZone>): Component => {
    const polygons: Array<Polygon> = []
    const classes: Array<string> = []
    for (const zone of zones) {
      for (const polygon of geometryToPolygons(zone.geometry)) {
        polygons.push(polygon)
        classes.push(zone.hazardClass)
      }
    }
    return { polygons, classes }
  }

  const zones = (inundation.zones ?? []) as ReadonlyArray<ModelZone>
  const { polygons, classes } = flatten(zones)

  const attribution = (inundation.attribution ?? {}) as Record<string, unknown>
  const componentOf = (key: string): Component | null => {
    const raw = attribution[key] as ReadonlyArray<ModelZone> | undefined
    return Array.isArray(raw) ? flatten(raw) : null
  }

  const floodedAreaKm2 = num(inundation.floodedAreaKm2)
  const polygonAreaKm2 = totalAreaKm2(polygons)
  const polyGridRatio = floodedAreaKm2 > 0 ? polygonAreaKm2 / floodedAreaKm2 : 1

  /**
   * Vectorisation drift is the one error that flatters every metric at once: a
   * dilated extent raises hit rate for free, and coarsened vectorisation once
   * faked a 12-point gain here; a run whose polygons disagree with its own grid
   * area is not evidence of anything.
   */
  if (floodedAreaKm2 > 0 && Math.abs(polyGridRatio - 1) > 0.01) {
    throw new Error(
      `${event.id}: returned polygons cover ${polygonAreaKm2.toFixed(1)} km² against a reported ` +
        `${floodedAreaKm2.toFixed(1)} km² (${polyGridRatio.toFixed(2)}×). The vectorisation moved.`,
    )
  }

  return {
    polygons,
    classes,
    pluvial: componentOf('pluvialZones'),
    fluvial: componentOf('fluvialZones'),
    fluvialPegged: componentOf('fluvialPeggedZones'),
    floodedAreaKm2,
    polygonAreaKm2,
    polyGridRatio,
    response: body,
  }
}

/**
 * Asks for each site once at a small radius, purely to put its ERA5 series on
 * disk before a sweep starts.
 *
 * Without it the first config of a sweep pays the archive call for every site,
 * and if the daily cap bites halfway through, the sweep is half warm and half
 * fallen back — two configurations that are not comparable and no sign of it in
 * the table. Levees are not required here: this run is a warm-up that no scored
 * run ever uses, and paying the rate limit for it would hit exactly the
 * upstream this harness has the most trouble getting an answer out of.
 */
export const warmClimatology = async (
  sites: ReadonlyArray<Observed>,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<void> => {
  for (const site of sites) {
    // This request exists only to populate/read the location-keyed ERA5 store.
    // Do not spend Overpass capacity (or wait on its retry ladder) for inputs
    // the warm-up never inspects.
    await runModel(
      site,
      {
        radiusKm: 5,
        useLevees: false,
        maskPermanentWater: false,
        useDams: false,
        useStormSewers: false,
        useBuildings: false,
      },
      baseUrl,
      { requireLevees: false },
    )
  }
}
