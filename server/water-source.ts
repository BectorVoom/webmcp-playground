/**
 * Mapped standing water, from OpenStreetMap via Overpass.
 *
 * The model has no way to tell a lake from low ground, so without this it
 * reports every lake, reservoir and river channel in the window as flood — 15
 * to 33% of the false-positive area at every hindcast site. See
 * `src/lib/hydrology/water.ts` for why both mechanisms are drawn to standing
 * water, and docs/specs/flood-model/plan-reference-and-dem.md §8 for the
 * measurement.
 *
 * Best-effort in exactly the way the embankments are, and for the same reasons:
 * Overpass is a free community service, it answers a 20 km box with megabytes,
 * and it returns 504 under load. An outage degrades the model to "no known
 * water bodies" — which restores the old, over-generous extent rather than
 * losing the request — and the status travels with the answer so a caller can
 * tell a clean run from a degraded one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BBox } from '../src/domain/geo'
import type { WaterBody } from '../src/lib/hydrology/water'
import type { GeoProxyService } from './geo-proxy'
import { BoundedCache } from './static-cache'

export const WATER_SOURCE_ID = 'global.osm.water'
export const WATER_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

/** Same budget as the embankments: a wide box legitimately takes tens of seconds. */
const OVERPASS_TIMEOUT_MS = 75_000

/** Beyond this the reply stops being worth reading; Overpass is asked to stop too. */
const MAX_ELEMENTS = 4000

const waterCache = new BoundedCache<WaterFetchResult>({ maxEntries: 64, ttlMs: 60 * 60 * 1000 })

export const waterCacheStats = () => waterCache.stats

/**
 * Relations as well as ways. Every lake worth the name is mapped as a
 * multipolygon relation — Lake Nojiri is relation 2314067 — and a way-only
 * query silently omits the largest body of water in the window while returning
 * a confident-looking list of ponds.
 *
 * **`intermittent=yes` is excluded, and that exclusion is load-bearing.** The
 * case for masking standing water is that it is already wet, so reporting it as
 * flood tells a reader nothing they can act on. An intermittent body is dry most
 * of the time: it *is* land that floods, and in an arid catchment the ephemeral
 * wash is the flash-flood hazard rather than an exception to it. Masking those
 * would delete real warning, which is the one direction this feature must never
 * fail in.
 *
 * It is not a rare tag. Around Tucson 40% of mapped water bodies carry it,
 * against 3-10% at every temperate site surveyed and 5.6% at Joso — so the four
 * Japanese events this was calibrated on could not have exposed it.
 */
export const overpassWaterQuery = ([minLon, minLat, maxLon, maxLat]: BBox): string => {
  const box = `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`
  return (
    `[out:json][timeout:90];(` +
    `way["natural"="water"]["intermittent"!="yes"](${box});` +
    `relation["natural"="water"]["intermittent"!="yes"](${box});` +
    `way["landuse"="reservoir"]["intermittent"!="yes"](${box});` +
    `relation["landuse"="reservoir"]["intermittent"!="yes"](${box});` +
    `);out geom ${MAX_ELEMENTS};`
  )
}

interface OverpassNode {
  readonly lat?: number
  readonly lon?: number
}
interface OverpassElement {
  readonly type?: string
  readonly geometry?: ReadonlyArray<OverpassNode>
  readonly members?: ReadonlyArray<{
    readonly role?: string
    readonly type?: string
    readonly geometry?: ReadonlyArray<OverpassNode>
  }>
  readonly tags?: Record<string, string>
}

type Ring = Array<readonly [number, number]>

const ringOf = (geometry: ReadonlyArray<OverpassNode> | undefined): Ring | null => {
  if (!Array.isArray(geometry)) return null
  const ring: Ring = []
  for (const node of geometry) {
    if (typeof node?.lon !== 'number' || typeof node?.lat !== 'number') continue
    ring.push([node.lon, node.lat])
  }
  return ring.length >= 2 ? ring : null
}

/**
 * Dry most of the year, and therefore land that floods rather than water that is
 * already there. `seasonal` is checked alongside `intermittent`: different
 * mappers reach for different tags for the same fact.
 */
const isIntermittent = (tags: Record<string, string> | undefined): boolean =>
  tags?.intermittent === 'yes' || tags?.seasonal === 'yes'

const samePoint = (a: readonly [number, number], b: readonly [number, number]): boolean =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

/**
 * Joins a multipolygon's member ways into closed rings.
 *
 * A relation's outer boundary is split across however many ways the mappers
 * found convenient, so the segments have to be walked end to end before the
 * shape means anything. Treating each segment as its own ring instead produces
 * slivers that contain nothing, which is a silent under-mask rather than an
 * error.
 */
export const stitchRings = (segments: ReadonlyArray<Ring>): Array<Ring> => {
  const pool = segments.filter((segment) => segment.length >= 2).map((segment) => [...segment])
  const rings: Array<Ring> = []

  while (pool.length > 0) {
    const ring = pool.shift()!
    // A single way may already be a closed ring; otherwise walk on.
    for (let guard = 0; guard < 10_000; guard++) {
      if (ring.length >= 4 && samePoint(ring[0]!, ring[ring.length - 1]!)) break
      const head = ring[ring.length - 1]!
      const next = pool.findIndex(
        (segment) => samePoint(segment[0]!, head) || samePoint(segment[segment.length - 1]!, head),
      )
      if (next < 0) break
      const [segment] = pool.splice(next, 1)
      const oriented = samePoint(segment![0]!, head) ? segment! : [...segment!].reverse()
      ring.push(...oriented.slice(1))
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

export interface ParsedWater {
  readonly bodies: ReadonlyArray<WaterBody>
  readonly wayCount: number
  readonly relationCount: number
}

export const parseOverpassWater = (body: string): ParsedWater | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const elements = (parsed as { elements?: ReadonlyArray<OverpassElement> })?.elements
  if (!Array.isArray(elements)) return null

  const bodies: Array<WaterBody> = []
  let wayCount = 0
  let relationCount = 0

  for (const element of elements) {
    // Also enforced in the query; repeated here so a payload stored before that
    // filter existed is not trusted on read.
    if (isIntermittent(element?.tags)) continue
    if (element?.type === 'way') {
      const ring = ringOf(element.geometry)
      if (ring === null || ring.length < 3) continue
      bodies.push({ rings: [ring] })
      wayCount++
      continue
    }
    if (element?.type === 'relation' && Array.isArray(element.members)) {
      const outer: Array<Ring> = []
      const inner: Array<Ring> = []
      for (const member of element.members) {
        const ring = ringOf(member?.geometry)
        if (ring === null) continue
        // Overpass omits the role on a plain multipolygon outer; treat it as outer.
        if ((member.role ?? 'outer') === 'inner') inner.push(ring)
        else outer.push(ring)
      }
      const rings = [...stitchRings(outer), ...stitchRings(inner)]
      if (rings.length === 0) continue
      bodies.push({ rings })
      relationCount++
    }
  }
  return { bodies, wayCount, relationCount }
}

export interface WaterFetchResult {
  readonly bodies: ReadonlyArray<WaterBody>
  readonly wayCount: number
  readonly relationCount: number
  /** Why the result is what it is — 'ok', 'disabled', 'fixture', or a failure. */
  readonly status: string
  readonly retrievedFrom?: 'overpass' | 'stored' | 'none'
}

const EMPTY = { bodies: [] as ReadonlyArray<WaterBody>, wayCount: 0, relationCount: 0 }

/**
 * Bumped whenever what we *ask Overpass for* changes, because the store holds
 * parsed geometry rather than the raw reply — so a filter added to the query can
 * never retroactively apply to what is already on disk. Version 2 excludes
 * intermittent water. A store written by an older version is ignored rather than
 * trusted, which beats relying on everyone remembering to delete a directory.
 */
const STORE_VERSION = 2

interface StoredWater {
  readonly version?: number
  readonly bbox: BBox
  readonly bodies: ReadonlyArray<WaterBody>
  readonly wayCount: number
  readonly relationCount: number
  readonly retrievedAt: string
  readonly source: string
}

const boxKey = (bbox: BBox): string => bbox.map((v) => v.toFixed(4)).join(',')

const waterPath = (dir: string, bbox: BBox): string =>
  join(dir, `${boxKey(bbox).replace(/,/g, '_')}.json`)

export const readStoredWater = (dir: string, bbox: BBox): StoredWater | undefined => {
  if (dir === '') return undefined
  try {
    const parsed = JSON.parse(readFileSync(waterPath(dir, bbox), 'utf8')) as StoredWater
    if (!Array.isArray(parsed?.bodies)) return undefined
    if (typeof parsed.wayCount !== 'number') return undefined
    if (parsed.version !== STORE_VERSION) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Written atomically, so a half-written file cannot read back as a smaller lake. */
export const writeStoredWater = (
  dir: string,
  bbox: BBox,
  result: WaterFetchResult,
  now = new Date(),
): void => {
  if (dir === '') return
  try {
    mkdirSync(dir, { recursive: true })
    const target = waterPath(dir, bbox)
    const temporary = `${target}.${process.pid}.tmp`
    const record: StoredWater = {
      version: STORE_VERSION,
      bbox,
      bodies: result.bodies,
      wayCount: result.wayCount,
      relationCount: result.relationCount,
      retrievedAt: now.toISOString(),
      source: WATER_SOURCE_ID,
    }
    writeFileSync(temporary, JSON.stringify(record))
    renameSync(temporary, target)
  } catch {
    // Nothing here is worth failing a flood model over.
  }
}

export const loadWater = async (
  proxy: GeoProxyService,
  bbox: BBox,
  fixtureMode: boolean,
  options: { readonly cacheDir?: string } = {},
): Promise<WaterFetchResult> => {
  if (fixtureMode) {
    return { ...EMPTY, status: 'fixture: no water data', retrievedFrom: 'none' }
  }
  const { cacheDir = '' } = options
  const key = boxKey(bbox)
  const cached = waterCache.get(key)
  if (cached !== undefined) return cached

  const stored = readStoredWater(cacheDir, bbox)
  if (stored !== undefined) {
    const result: WaterFetchResult = {
      bodies: stored.bodies,
      wayCount: stored.wayCount,
      relationCount: stored.relationCount,
      status: 'ok',
      retrievedFrom: 'stored',
    }
    waterCache.set(key, result)
    return result
  }

  try {
    const res = await proxy.fetchUpstream(WATER_SOURCE_ID, OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(overpassWaterQuery(bbox))}`,
      timeoutMs: OVERPASS_TIMEOUT_MS,
      maxBytes: 24 * 1024 * 1024,
    })
    if (res.status !== 200) {
      return { ...EMPTY, status: `overpass HTTP ${res.status}`, retrievedFrom: 'none' }
    }
    const parsed = parseOverpassWater(res.body)
    if (parsed === null) {
      return { ...EMPTY, status: 'overpass reply unreadable', retrievedFrom: 'none' }
    }
    const result: WaterFetchResult = { ...parsed, status: 'ok', retrievedFrom: 'overpass' }
    // As with the embankments: remember a good answer, never an outage.
    waterCache.set(key, result)
    writeStoredWater(cacheDir, bbox, result)
    return result
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...EMPTY, status: `overpass failed: ${message}`, retrievedFrom: 'none' }
  }
}
