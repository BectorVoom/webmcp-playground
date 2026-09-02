/**
 * Dams, storm drainage, and building footprints from OpenStreetMap/Overpass.
 *
 * This source is best-effort. OSM has worldwide reach but infrastructure
 * coverage is uneven, especially for underground sewers, and a missing feature
 * must never be interpreted as proof that no structure exists. The fetch status
 * and feature counts travel with every model result for that reason.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BBox } from '../src/domain/geo'
import type {
  BuildingFootprint,
  InfrastructureGeometry,
  InfrastructurePoint,
  LinearInfrastructure,
} from '../src/lib/hydrology/infrastructure'
import type { GeoProxyService } from './geo-proxy'
import { BoundedCache } from './static-cache'
import { stitchRings } from './water-source'

export const INFRASTRUCTURE_SOURCE_ID = 'global.osm.flood-infrastructure'
export const INFRASTRUCTURE_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)'
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  // The front door currently announces this backend in /api/status. Keeping it
  // explicit gives connection failures a second official host without sending
  // the same query concurrently to several community instances.
  'https://lambert.openstreetmap.de/api/interpreter',
  // Global public instance listed by the OpenStreetMap Wiki (formerly Kumi).
  'https://overpass.private.coffee/api/interpreter',
] as const
const OVERPASS_TIMEOUT_MS = 90_000
const MAX_INFRASTRUCTURE_ELEMENTS = 8000
const MAX_BUILDING_ELEMENTS = 20_000
const MAX_SUBDIVISION_DEPTH = 10
const OVERPASS_RATE_LIMIT_DELAYS_MS = [15_000, 30_000, 60_000] as const

const infrastructureCache = new BoundedCache<InfrastructureFetchResult>({
  maxEntries: 64,
  ttlMs: 60 * 60 * 1000,
})

export const infrastructureCacheStats = () => infrastructureCache.stats

type InfrastructureSelection = 'all' | 'linear' | 'buildings'

/**
 * Infrastructure is output before buildings so a dense city hitting the
 * building cap cannot crowd every dam or drain out of the same reply.
 */
export const overpassInfrastructureQuery = (
  [minLon, minLat, maxLon, maxLat]: BBox,
  selection: InfrastructureSelection = 'all',
): string => {
  const box = `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`
  return (
    `[out:json][timeout:105];` +
    (selection === 'buildings'
      ? ''
      : `(` +
        `node["waterway"="dam"](${box});way["waterway"="dam"](${box});` +
        `node["man_made"="dam"](${box});way["man_made"="dam"](${box});` +
        `node["man_made"="storm_drain"](${box});` +
        `way["sewer"~"^(storm|combined)$"](${box});` +
        `way["waterway"="drain"](${box});` +
        `way["tunnel"="culvert"](${box});way["culvert"="yes"](${box});` +
        `);out geom ${MAX_INFRASTRUCTURE_ELEMENTS};`) +
    (selection === 'linear'
      ? ''
      : `(` +
        `way["building"]["building"!="no"](${box});` +
        `relation["building"]["building"!="no"](${box});` +
        `);out geom ${MAX_BUILDING_ELEMENTS};`)
  )
}

interface OverpassNode {
  readonly lat?: number
  readonly lon?: number
}

interface OverpassElement {
  readonly id?: number
  readonly type?: string
  readonly lat?: number
  readonly lon?: number
  readonly geometry?: ReadonlyArray<OverpassNode>
  readonly members?: ReadonlyArray<{
    readonly role?: string
    readonly geometry?: ReadonlyArray<OverpassNode>
  }>
  readonly tags?: Record<string, string>
}

type Ring = Array<InfrastructurePoint>

const pointOf = (node: OverpassNode): InfrastructurePoint | null =>
  typeof node.lon === 'number' && typeof node.lat === 'number'
    ? [node.lon, node.lat]
    : null

const pointsOf = (element: OverpassElement): Array<InfrastructurePoint> => {
  if (element.type === 'node') {
    const point = pointOf(element)
    return point === null ? [] : [point]
  }
  if (!Array.isArray(element.geometry)) return []
  const points: Array<InfrastructurePoint> = []
  for (const node of element.geometry) {
    const point = pointOf(node)
    if (point !== null) points.push(point)
  }
  return points
}

const isDam = (tags: Record<string, string> | undefined): boolean =>
  tags?.waterway === 'dam' || tags?.man_made === 'dam'

const isDrain = (tags: Record<string, string> | undefined): boolean =>
  tags?.man_made === 'storm_drain' ||
  tags?.sewer === 'storm' ||
  tags?.sewer === 'combined' ||
  tags?.waterway === 'drain' ||
  tags?.tunnel === 'culvert' ||
  tags?.culvert === 'yes'

const isBuilding = (tags: Record<string, string> | undefined): boolean =>
  tags?.building !== undefined && tags.building !== 'no'

const buildingOf = (element: OverpassElement): BuildingFootprint | null => {
  if (element.type === 'way') {
    const ring = pointsOf(element)
    return ring.length >= 3 ? { rings: [ring] } : null
  }
  if (element.type !== 'relation' || !Array.isArray(element.members)) return null

  const outer: Ring[] = []
  const inner: Ring[] = []
  for (const member of element.members) {
    if (!Array.isArray(member.geometry)) continue
    const ring = member.geometry
      .map(pointOf)
      .filter((point: InfrastructurePoint | null): point is InfrastructurePoint => point !== null)
    if (ring.length < 2) continue
    if ((member.role ?? 'outer') === 'inner') inner.push(ring)
    else outer.push(ring)
  }
  const rings = [...stitchRings(outer), ...stitchRings(inner)]
  return rings.length > 0 ? { rings } : null
}

export interface ParsedInfrastructure extends InfrastructureGeometry {
  readonly damElements: number
  readonly drainElements: number
  readonly buildingElements: number
  readonly truncated: boolean
}

export const parseOverpassInfrastructure = (
  body: string,
  selection: InfrastructureSelection = 'all',
): ParsedInfrastructure | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const elements = (parsed as { elements?: ReadonlyArray<OverpassElement> })?.elements
  if (!Array.isArray(elements)) return null

  const dams: LinearInfrastructure[] = []
  const drains: LinearInfrastructure[] = []
  const buildings: BuildingFootprint[] = []
  let damElements = 0
  let drainElements = 0
  let buildingElements = 0

  for (const element of elements) {
    if (isDam(element.tags)) {
      const points = pointsOf(element)
      if (points.length > 0) {
        dams.push({ points })
        damElements++
      }
    }
    if (isDrain(element.tags)) {
      const points = pointsOf(element)
      if (points.length > 0) {
        drains.push({ points })
        drainElements++
      }
    }
    if (isBuilding(element.tags)) {
      const footprint = buildingOf(element)
      if (footprint !== null) {
        buildings.push(footprint)
        buildingElements++
      }
    }
  }

  return {
    dams,
    drains,
    buildings,
    damElements,
    drainElements,
    buildingElements,
    // Hitting either out limit means the corresponding list may be partial.
    truncated:
      (selection !== 'buildings' && damElements + drainElements >= MAX_INFRASTRUCTURE_ELEMENTS) ||
      (selection !== 'linear' && buildingElements >= MAX_BUILDING_ELEMENTS),
  }
}

export interface InfrastructureFetchResult extends ParsedInfrastructure {
  readonly status: string
  readonly retrievedFrom: 'overpass' | 'stored' | 'none'
}

const EMPTY: ParsedInfrastructure = {
  dams: [],
  drains: [],
  buildings: [],
  damElements: 0,
  drainElements: 0,
  buildingElements: 0,
  truncated: false,
}

const STORE_VERSION = 1

interface StoredInfrastructure extends ParsedInfrastructure {
  readonly version: number
  readonly bbox: BBox
  readonly retrievedAt: string
  readonly source: string
}

const boxKey = (bbox: BBox): string => bbox.map((value) => value.toFixed(4)).join(',')

const infrastructurePath = (
  dir: string,
  bbox: BBox,
  selection: InfrastructureSelection = 'all',
): string => {
  const suffix = selection === 'all' ? '' : `.${selection}`
  return join(dir, 'infrastructure', `${boxKey(bbox).replace(/,/g, '_')}${suffix}.json`)
}

export const readStoredInfrastructure = (
  dir: string,
  bbox: BBox,
  selection: InfrastructureSelection = 'all',
): StoredInfrastructure | undefined => {
  if (dir === '') return undefined
  try {
    const parsed = JSON.parse(readFileSync(infrastructurePath(dir, bbox, selection), 'utf8')) as StoredInfrastructure
    if (parsed.version !== STORE_VERSION) return undefined
    if (!Array.isArray(parsed.dams) || !Array.isArray(parsed.drains) || !Array.isArray(parsed.buildings)) {
      return undefined
    }
    if (typeof parsed.damElements !== 'number' || typeof parsed.buildingElements !== 'number') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export const writeStoredInfrastructure = (
  dir: string,
  bbox: BBox,
  result: InfrastructureFetchResult,
  selection: InfrastructureSelection = 'all',
  now = new Date(),
): void => {
  if (dir === '') return
  try {
    const target = infrastructurePath(dir, bbox, selection)
    mkdirSync(join(dir, 'infrastructure'), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    const stored: StoredInfrastructure = {
      version: STORE_VERSION,
      bbox,
      dams: result.dams,
      drains: result.drains,
      buildings: result.buildings,
      damElements: result.damElements,
      drainElements: result.drainElements,
      buildingElements: result.buildingElements,
      truncated: result.truncated,
      retrievedAt: now.toISOString(),
      source: INFRASTRUCTURE_SOURCE_ID,
    }
    writeFileSync(temporary, JSON.stringify(stored))
    renameSync(temporary, target)
  } catch {
    // Infrastructure is a refinement; inability to cache it must not fail the model.
  }
}

const storedResult = (stored: StoredInfrastructure): InfrastructureFetchResult => ({
  dams: stored.dams,
  drains: stored.drains,
  buildings: stored.buildings,
  damElements: stored.damElements,
  drainElements: stored.drainElements,
  buildingElements: stored.buildingElements,
  truncated: stored.truncated,
  status: stored.truncated ? 'partial: Overpass element cap reached' : 'ok',
  retrievedFrom: 'stored',
})

const storedCategoryFallback = (
  stored: StoredInfrastructure,
  selection: Exclude<InfrastructureSelection, 'all'>,
): InfrastructureFetchResult => ({
  dams: selection === 'linear' ? stored.dams : [],
  drains: selection === 'linear' ? stored.drains : [],
  buildings: selection === 'buildings' ? stored.buildings : [],
  damElements: selection === 'linear' ? stored.damElements : 0,
  drainElements: selection === 'linear' ? stored.drainElements : 0,
  buildingElements: selection === 'buildings' ? stored.buildingElements : 0,
  truncated: true,
  status: `partial: reused incomplete combined ${selection} layer`,
  retrievedFrom: 'stored',
})

/**
 * Split along the longer angular axis. The model boxes are small enough that
 * longitude and latitude degrees have similar scale, and alternating the long
 * side produces a balanced grid without querying overlapping interiors.
 */
const splitBBox = ([minLon, minLat, maxLon, maxLat]: BBox): readonly [BBox, BBox] => {
  if (maxLon - minLon >= maxLat - minLat) {
    const middle = (minLon + maxLon) / 2
    return [[minLon, minLat, middle, maxLat], [middle, minLat, maxLon, maxLat]]
  }
  const middle = (minLat + maxLat) / 2
  return [[minLon, minLat, maxLon, middle], [minLon, middle, maxLon, maxLat]]
}

const lineKey = (feature: LinearInfrastructure): string => JSON.stringify(feature.points)
const buildingKey = (feature: BuildingFootprint): string => JSON.stringify(feature.rings)

/** Overpass returns a full way in every tile touched by one of its nodes. */
const mergeInfrastructure = (
  parts: ReadonlyArray<InfrastructureFetchResult>,
): InfrastructureFetchResult => {
  const dams = new Map<string, LinearInfrastructure>()
  const drains = new Map<string, LinearInfrastructure>()
  const buildings = new Map<string, BuildingFootprint>()
  for (const part of parts) {
    for (const dam of part.dams) dams.set(lineKey(dam), dam)
    for (const drain of part.drains) drains.set(lineKey(drain), drain)
    for (const building of part.buildings) buildings.set(buildingKey(building), building)
  }
  const anyOverpass = parts.some((part) => part.retrievedFrom === 'overpass')
  const anyStored = parts.some((part) => part.retrievedFrom === 'stored')
  const truncated = parts.some((part) => part.truncated)
  const incomplete = parts.find((part) => part.truncated)
  return {
    dams: [...dams.values()],
    drains: [...drains.values()],
    buildings: [...buildings.values()],
    damElements: dams.size,
    drainElements: drains.size,
    buildingElements: buildings.size,
    truncated,
    status: truncated
      ? `partial: subdivision incomplete (${incomplete?.status ?? 'unknown child status'})`
      : 'ok',
    retrievedFrom: anyOverpass ? 'overpass' : anyStored ? 'stored' : 'none',
  }
}

const fetchSubdivisions = async (
  proxy: GeoProxyService,
  bbox: BBox,
  cacheDir: string,
  depth: number,
  selection: InfrastructureSelection,
  fallback?: InfrastructureFetchResult,
): Promise<InfrastructureFetchResult> => {
  const children: InfrastructureFetchResult[] = []
  for (const childBBox of splitBBox(bbox)) {
    const child = await fetchInfrastructure(proxy, childBBox, cacheDir, depth + 1, selection)
    if (child.retrievedFrom === 'none') {
      const completed = fallback === undefined
        ? mergeInfrastructure(children)
        : mergeInfrastructure([fallback, ...children])
      const partial: InfrastructureFetchResult = {
        ...completed,
        status: `partial: subdivision failed (${child.status})`,
        truncated: true,
        // The parent query reached Overpass before it subdivided. Marking this
        // as retrieved lets the caller retain its completed siblings, while
        // `truncated` prevents either source or whole-model caching as complete.
        retrievedFrom: completed.retrievedFrom === 'none' ? 'overpass' : completed.retrievedFrom,
      }
      writeStoredInfrastructure(cacheDir, bbox, partial, selection)
      return partial
    }
    children.push(child)
  }
  const merged = mergeInfrastructure(children)
  writeStoredInfrastructure(cacheDir, bbox, merged, selection)
  return merged
}

const fetchInfrastructure = async (
  proxy: GeoProxyService,
  bbox: BBox,
  cacheDir: string,
  depth: number,
  selection: InfrastructureSelection,
): Promise<InfrastructureFetchResult> => {
  const stored = readStoredInfrastructure(cacheDir, bbox, selection)
  let result: InfrastructureFetchResult

  if (stored !== undefined) {
    result = storedResult(stored)
  } else if (splitBBox(bbox).some(
    (childBBox) => readStoredInfrastructure(cacheDir, childBBox, selection) !== undefined,
  )) {
    // A previous 504 may have completed one child before its sibling failed.
    // Older stores did not leave a partial parent marker, so discover those
    // orphan children before paying to repeat the larger query.
    return fetchSubdivisions(proxy, bbox, cacheDir, depth, selection)
  } else {
    try {
      let response: Awaited<ReturnType<GeoProxyService['fetchUpstream']>> | undefined
      let lastRequestError: unknown
      for (let attempt = 0; attempt <= OVERPASS_RATE_LIMIT_DELAYS_MS.length; attempt++) {
        try {
          const targetUrl = OVERPASS_URLS[attempt % OVERPASS_URLS.length]!
          const circuitSourceId = targetUrl === OVERPASS_URLS[0]
            ? INFRASTRUCTURE_SOURCE_ID
            : `${INFRASTRUCTURE_SOURCE_ID}:${new URL(targetUrl).hostname}`
          const queryUrl = `${targetUrl}?data=${encodeURIComponent(overpassInfrastructureQuery(bbox, selection))}`
          response = await proxy.fetchUpstream(circuitSourceId, queryUrl, {
            method: 'GET',
            retries: 0,
            timeoutMs: OVERPASS_TIMEOUT_MS,
            maxBytes: 48 * 1024 * 1024,
          })
          lastRequestError = undefined
          if (response.status !== 429 && (response.status < 500 || response.status === 504)) break
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          if (/HostNotAllowed|UpstreamTooLarge/i.test(message)) throw error
          lastRequestError = error
        }
        const delay = OVERPASS_RATE_LIMIT_DELAYS_MS[attempt]
        if (delay === undefined) break
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      if (response === undefined) {
        const message = lastRequestError instanceof Error ? lastRequestError.message : String(lastRequestError)
        return { ...EMPTY, status: `overpass failed after backoff: ${message}`, retrievedFrom: 'none' }
      }
      if (response.status !== 200) {
        // A gateway timeout usually means the query box is too expensive for
        // Overpass. Smaller boxes are the recovery; retrying the same POST is
        // both slower and harder on the shared service.
        if (response.status === 504 && depth < MAX_SUBDIVISION_DEPTH) {
          return fetchSubdivisions(proxy, bbox, cacheDir, depth, selection)
        }
        return { ...EMPTY, status: `overpass HTTP ${response.status}`, retrievedFrom: 'none' }
      }
      const parsed = parseOverpassInfrastructure(response.body, selection)
      if (parsed === null) {
        return { ...EMPTY, status: 'overpass reply unreadable', retrievedFrom: 'none' }
      }
      result = {
        ...parsed,
        status: parsed.truncated ? 'partial: Overpass element cap reached' : 'ok',
        retrievedFrom: 'overpass',
      }
      // A capped parent is useful progress: a later attempt can resume at its
      // children instead of paying for the known-incomplete large query again.
      writeStoredInfrastructure(cacheDir, bbox, result, selection)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (/abort|timeout/i.test(message) && depth < MAX_SUBDIVISION_DEPTH) {
        return fetchSubdivisions(proxy, bbox, cacheDir, depth, selection)
      }
      return { ...EMPTY, status: `overpass failed: ${message}`, retrievedFrom: 'none' }
    }
  }

  if (!result.truncated || depth >= MAX_SUBDIVISION_DEPTH) return result
  return fetchSubdivisions(proxy, bbox, cacheDir, depth, selection, result)
}

export const loadInfrastructure = async (
  proxy: GeoProxyService,
  bbox: BBox,
  fixtureMode: boolean,
  options: { readonly cacheDir?: string } = {},
): Promise<InfrastructureFetchResult> => {
  if (fixtureMode) {
    return { ...EMPTY, status: 'fixture: no infrastructure data', retrievedFrom: 'none' }
  }
  const { cacheDir = '' } = options
  const key = boxKey(bbox)
  const cached = infrastructureCache.get(key)
  if (cached !== undefined) return cached

  const stored = readStoredInfrastructure(cacheDir, bbox)
  if (stored !== undefined && !stored.truncated) {
    const result = storedResult(stored)
    infrastructureCache.set(key, result)
    return result
  }

  // Fetch the two independently capped layers separately. This prevents every
  // dense-building subdivision from re-asking thousands of drains (and vice
  // versa), and gives each layer its own resumable disk tree.
  const fetchedLinear = await fetchInfrastructure(proxy, bbox, cacheDir, 0, 'linear')
  const fetchedBuildings = await fetchInfrastructure(proxy, bbox, cacheDir, 0, 'buildings')
  const linear = fetchedLinear.retrievedFrom === 'none' && stored !== undefined
    ? storedCategoryFallback(stored, 'linear')
    : fetchedLinear
  const buildings = fetchedBuildings.retrievedFrom === 'none' && stored !== undefined
    ? storedCategoryFallback(stored, 'buildings')
    : fetchedBuildings
  const merged = mergeInfrastructure([linear, buildings])
  const incomplete = [fetchedLinear, fetchedBuildings].find(
    (part) => part.retrievedFrom === 'none' || part.truncated,
  )
  const result: InfrastructureFetchResult = incomplete === undefined
    ? merged
    : {
        ...merged,
        status: `partial: independent layer incomplete (${incomplete.status})`,
        truncated: true,
      }
  if (result.retrievedFrom !== 'none') writeStoredInfrastructure(cacheDir, bbox, result)
  if (result.retrievedFrom !== 'none' && !result.truncated) {
    infrastructureCache.set(key, result)
  }
  return result
}
