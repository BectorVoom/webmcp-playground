/**
 * Embankment geometry from OpenStreetMap, via Overpass.
 *
 * There is no global levee dataset. The USACE National Levee Database covers
 * the US, Japan's GSI publishes 治水地形分類図 as a colour raster, and neither
 * generalises. OSM is the one source with worldwide coverage, keyless access
 * and vector geometry, and it is already on this server's host allowlist.
 *
 * Its coverage is uneven and the caller is told so: measured across five
 * Japanese flood sites it ranged from 950 embankment ways near Mabi to 7 near
 * Hitoyoshi. The count is reported with every result, because a model that
 * silently assumes "no data" means "no defences" would be most confident
 * exactly where it knows least.
 *
 * Road and railway embankments are included deliberately. They are not flood
 * defences by design, but they are barriers by construction, and in real events
 * they compartmentalise inundation just as levees do.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BBox } from '../src/domain/geo'
import type { LeveeSegment } from '../src/lib/hydrology/levee'
import type { GeoProxyService } from './geo-proxy'
import { BoundedCache } from './static-cache'

export const LEVEE_SOURCE_ID = 'global.osm.embankments'
export const LEVEE_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
/**
 * Overpass is slow by nature — a 40 km box takes tens of seconds — and the
 * default proxy budget is set for point lookups. Given generously here because
 * the alternative is never getting an answer, and a failure only degrades the
 * model to "no known defences".
 */
const OVERPASS_TIMEOUT_MS = 75_000

/** Beyond this the reply stops being worth reading; Overpass is asked to stop too. */
const MAX_WAYS = 4000

/**
 * `man_made` carries the purpose-built defences; `embankment=yes` and
 * `barrier=embankment` carry the roads and railways that act as ones.
 */
/**
 * Mapped embankments, keyed on the query box. OSM changes continuously but not
 * on the timescale of a session, so an hour is plenty and saves the slowest
 * upstream in the pipeline on every repeat.
 */
const leveeCache = new BoundedCache<LeveeFetchResult>({ maxEntries: 64, ttlMs: 60 * 60 * 1000 })

export const leveeCacheStats = () => leveeCache.stats

export const overpassLeveeQuery = ([minLon, minLat, maxLon, maxLat]: BBox): string => {
  const box = `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`
  return (
    `[out:json][timeout:90];(` +
    `way["man_made"~"^(dyke|levee|embankment)$"](${box});` +
    `way["embankment"="yes"](${box});` +
    `way["barrier"="embankment"](${box});` +
    `);out geom ${MAX_WAYS};`
  )
}

interface OverpassWay {
  readonly type?: string
  readonly geometry?: ReadonlyArray<{ readonly lat?: number; readonly lon?: number }>
  readonly tags?: Record<string, string>
}

/** Metres from an OSM `height`/`ele` style tag, or undefined when unusable. */
const parseHeight = (tags: Record<string, string> | undefined): number | undefined => {
  const raw = tags?.height ?? tags?.['est_height']
  if (raw === undefined) return undefined
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 50) return undefined
  return value
}

export interface ParsedLevees {
  readonly segments: ReadonlyArray<LeveeSegment>
  readonly wayCount: number
  readonly withRecordedHeight: number
}

export const parseOverpassLevees = (body: string): ParsedLevees | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const elements = (parsed as { elements?: ReadonlyArray<OverpassWay> })?.elements
  if (!Array.isArray(elements)) return null

  const segments: Array<LeveeSegment> = []
  let withRecordedHeight = 0
  for (const way of elements) {
    const geometry = way?.geometry
    if (!Array.isArray(geometry) || geometry.length < 2) continue
    const points: Array<readonly [number, number]> = []
    for (const node of geometry) {
      if (typeof node?.lon !== 'number' || typeof node?.lat !== 'number') continue
      points.push([node.lon, node.lat])
    }
    if (points.length < 2) continue
    const heightM = parseHeight(way.tags)
    if (heightM !== undefined) withRecordedHeight++
    segments.push({ points, heightM })
  }
  return { segments, wayCount: segments.length, withRecordedHeight }
}

export interface LeveeFetchResult {
  readonly segments: ReadonlyArray<LeveeSegment>
  readonly wayCount: number
  readonly withRecordedHeight: number
  /** Why the result is what it is — 'ok', 'disabled', 'fixture', or a failure. */
  readonly status: string
  /** Where the geometry came from, as the climatology reports its own provenance. */
  readonly retrievedFrom?: 'overpass' | 'stored' | 'none'
}

interface StoredLevees {
  readonly bbox: BBox
  readonly segments: ReadonlyArray<LeveeSegment>
  readonly wayCount: number
  readonly withRecordedHeight: number
  readonly retrievedAt: string
  readonly source: string
}

/** The query box to four decimals, the same resolution the in-memory cache keys on. */
const boxKey = (bbox: BBox): string => bbox.map((v) => v.toFixed(4)).join(',')

const leveePath = (dir: string, bbox: BBox): string =>
  join(dir, `${boxKey(bbox).replace(/,/g, '_')}.json`)

/** The stored geometry, or undefined for anything unreadable — a cache is never load-bearing. */
export const readStoredLevees = (dir: string, bbox: BBox): StoredLevees | undefined => {
  if (dir === '') return undefined
  try {
    const parsed = JSON.parse(readFileSync(leveePath(dir, bbox), 'utf8')) as StoredLevees
    if (!Array.isArray(parsed?.segments)) return undefined
    if (typeof parsed.wayCount !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Write the geometry, atomically and best-effort — renamed into place so a
 * half-written file cannot be read back as a shorter levee network.
 */
export const writeStoredLevees = (
  dir: string,
  bbox: BBox,
  result: LeveeFetchResult,
  now = new Date(),
): void => {
  if (dir === '') return
  try {
    mkdirSync(dir, { recursive: true })
    const target = leveePath(dir, bbox)
    const temporary = `${target}.${process.pid}.tmp`
    const record: StoredLevees = {
      bbox,
      segments: result.segments,
      wayCount: result.wayCount,
      withRecordedHeight: result.withRecordedHeight,
      retrievedAt: now.toISOString(),
      source: LEVEE_SOURCE_ID,
    }
    writeFileSync(temporary, JSON.stringify(record))
    renameSync(temporary, target)
  } catch {
    // Nothing here is worth failing a flood model over.
  }
}

/**
 * Best-effort: a defence dataset is a refinement, so an Overpass outage
 * degrades the model to "no known defences" rather than failing the request.
 * The status travels with the answer so the caller can tell the two apart.
 *
 * Kept on disk between runs for the same reason the rainfall climatology is.
 * Overpass is a free community service that asks not to be hammered, it answers
 * a 20 km box with megabytes and returns 504 under load, and OSM embankments
 * change on the timescale of a construction project. Before the store existed a
 * server restart cost a fresh megabyte-scale query per site, and a run whose
 * lookup failed silently reported the floodplain as undefended — 18.5 km² of
 * extent at Joso, enough to invalidate a comparison.
 */
export const loadLevees = async (
  proxy: GeoProxyService,
  bbox: BBox,
  fixtureMode: boolean,
  options: { readonly cacheDir?: string } = {},
): Promise<LeveeFetchResult> => {
  if (fixtureMode) {
    return {
      segments: [], wayCount: 0, withRecordedHeight: 0,
      status: 'fixture: no embankment data', retrievedFrom: 'none',
    }
  }
  const { cacheDir = '' } = options
  const key = boxKey(bbox)
  const cached = leveeCache.get(key)
  if (cached !== undefined) return cached

  const stored = readStoredLevees(cacheDir, bbox)
  if (stored !== undefined) {
    const result: LeveeFetchResult = {
      segments: stored.segments,
      wayCount: stored.wayCount,
      withRecordedHeight: stored.withRecordedHeight,
      status: 'ok',
      retrievedFrom: 'stored',
    }
    leveeCache.set(key, result)
    return result
  }

  try {
    const query = overpassLeveeQuery(bbox)
    const res = await proxy.fetchUpstream(LEVEE_SOURCE_ID, OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      // Overpass answers a wide box with megabytes of geometry.
      maxBytes: 24 * 1024 * 1024,
    })
    if (res.status !== 200) {
      return {
        segments: [], wayCount: 0, withRecordedHeight: 0,
        status: `overpass HTTP ${res.status}`, retrievedFrom: 'none',
      }
    }
    const parsed = parseOverpassLevees(res.body)
    if (parsed === null) {
      return {
        segments: [], wayCount: 0, withRecordedHeight: 0,
        status: 'overpass reply unreadable', retrievedFrom: 'none',
      }
    }
    const result: LeveeFetchResult = { ...parsed, status: 'ok', retrievedFrom: 'overpass' }
    // As with climatology: remember a good answer, never an outage.
    leveeCache.set(key, result)
    writeStoredLevees(cacheDir, bbox, result)
    return result
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      segments: [], wayCount: 0, withRecordedHeight: 0,
      status: `overpass failed: ${message}`, retrievedFrom: 'none',
    }
  }
}
