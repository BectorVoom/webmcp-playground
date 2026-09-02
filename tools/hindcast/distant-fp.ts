/**
 * Where does the model put water that is nowhere near the official envelope?
 *
 * Round ten §7 found Nagano carrying 8.0% of its false-positive area more than
 * 3 km from any designated flood zone — four times any other site, and the one
 * error left there that geometry and base rate do not explain. "Distant" is a
 * symptom, not a diagnosis, so this asks what those cells actually are.
 *
 * Four cuts, each separating a benign explanation from a real defect:
 *
 *   designation  Is the ground simply unassessed? Being far from the envelope
 *                and being outside every designated river are close to the same
 *                statement, so this has to be ruled out before anything else.
 *   mechanism    Rain ponding or river stage? They fail for different reasons
 *                and would be fixed in different code.
 *   elevation    Upland or valley floor? Water high above the river is a
 *                different failure from water spread too wide along it.
 *   clustering   One place or everywhere? A handful of large blobs is a feature
 *                of the terrain; a fine scatter is noise.
 *
 *   bun tools/hindcast/distant-fp.ts [event] [config]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { eventById } from './events'
import { loadObserved } from './observed'
import { runModel, warmClimatology } from './model'
import { buildLattice, scoreRun, distanceToMask, percent, type Lattice } from './score'
import { CONFIGS } from './run'
import { loadHazardMask } from './hazard'
import { PolygonIndex } from './geometry'
import { decodeGsiDemElevations } from '../../src/lib/hydrology/terrain'
import { DEFAULT_DEM_CACHE_DIR } from '../../server/flood-inputs'

const CELL_AREA_KM2 = 0.01
const DISTANT_M = 3000
const DEM_ZOOM = 12
const TILE = 256

/**
 * Samples the cached GSI mosaic at a point. Read straight off disk rather than
 * through the route, because the question is what the ground under a cell looks
 * like and the route only ever reports what it decided about it.
 */
const makeElevationSampler = (): ((lon: number, lat: number) => number) => {
  const tiles = new Map<string, Float32Array | null>()
  return (lon, lat) => {
    const scale = 2 ** DEM_ZOOM * TILE
    const px = ((lon + 180) / 360) * scale
    const rad = (lat * Math.PI) / 180
    const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale
    const tx = Math.floor(px / TILE)
    const ty = Math.floor(py / TILE)
    const key = `${tx}/${ty}`
    let grid = tiles.get(key)
    if (grid === undefined) {
      const path = join(DEFAULT_DEM_CACHE_DIR, 'gsi10', String(DEM_ZOOM), String(tx), `${ty}.png`)
      if (existsSync(path)) {
        const png = PNG.sync.read(readFileSync(path))
        grid = decodeGsiDemElevations(new Uint8Array(png.data), png.width, png.height)
      } else {
        grid = null
      }
      tiles.set(key, grid)
    }
    if (!grid) return NaN
    const ix = Math.min(TILE - 1, Math.floor(px) - tx * TILE)
    const iy = Math.min(TILE - 1, Math.floor(py) - ty * TILE)
    return grid[iy * TILE + ix]!
  }
}

const quantiles = (values: ReadonlyArray<number>): string => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 'n/a'
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return `${at(0.1).toFixed(0)} / ${at(0.5).toFixed(0)} / ${at(0.9).toFixed(0)}`
}

/** 8-connected components of a point mask, over the lattice's grid slots. */
const clustersOf = (
  lattice: Lattice,
  mask: Uint8Array,
): Array<{ size: number; lon: number; lat: number }> => {
  const seen = new Uint8Array(mask.length)
  const clusters: Array<{ size: number; lon: number; lat: number }> = []
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start] === 1) continue
    const stack = [start]
    seen[start] = 1
    let size = 0
    let sumLon = 0
    let sumLat = 0
    while (stack.length > 0) {
      const point = stack.pop()!
      size++
      sumLon += lattice.points[point]!.longitude
      sumLat += lattice.points[point]!.latitude
      const slot = lattice.cellOf[point]!
      const row = Math.floor(slot / lattice.cols)
      const col = slot % lattice.cols
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const ny = row + dy
          const nx = col + dx
          if (ny < 0 || ny >= lattice.rows || nx < 0 || nx >= lattice.cols) continue
          const neighbour = lattice.cellIndex[ny * lattice.cols + nx]!
          if (neighbour < 0 || seen[neighbour] === 1 || mask[neighbour] !== 1) continue
          seen[neighbour] = 1
          stack.push(neighbour)
        }
      }
    }
    clusters.push({ size, lon: sumLon / size, lat: sumLat / size })
  }
  return clusters.sort((a, b) => b.size - a.size)
}

const WATER_CACHE_DIR = join('.cache', 'hindcast', 'water')

/**
 * Mapped lakes and reservoirs over the scored window, from OpenStreetMap.
 *
 * Kept on disk for the same reason the embankments are: Overpass is a free
 * community service and a 20 km box is a real question to ask it. Returns null
 * rather than throwing if it is unavailable — this is a diagnostic cut, and
 * losing it should cost a table, not the whole run.
 */
type OverpassPoint = { lat: number; lon: number }
type OverpassElement = {
  type: string
  geometry?: Array<OverpassPoint>
  members?: Array<{ role?: string; geometry?: Array<OverpassPoint> }>
}

/**
 * Stitches a multipolygon relation's outer members into closed rings.
 *
 * A lake of any size is mapped as a relation whose outer boundary is split
 * across several ways, so its segments have to be joined end to end before the
 * shape means anything. Taking each segment as its own ring instead silently
 * produces slivers that contain nothing — which is exactly how the first
 * version of this reported the biggest lake in the window as 3% water.
 */
const stitchRings = (segments: Array<Array<readonly [number, number]>>): Array<Array<readonly [number, number]>> => {
  const rings: Array<Array<readonly [number, number]>> = []
  const pool = segments.filter((s) => s.length >= 2)
  const same = (a: readonly [number, number], b: readonly [number, number]): boolean =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

  while (pool.length > 0) {
    const ring = [...pool.shift()!]
    for (;;) {
      if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) break
      const head = ring[ring.length - 1]!
      const next = pool.findIndex((s) => same(s[0]!, head) || same(s[s.length - 1]!, head))
      if (next < 0) break
      const [segment] = pool.splice(next, 1)
      const oriented = same(segment![0]!, head) ? segment! : [...segment!].reverse()
      ring.push(...oriented.slice(1))
    }
    if (ring.length >= 4) {
      if (!same(ring[0]!, ring[ring.length - 1]!)) ring.push(ring[0]!)
      rings.push(ring)
    }
  }
  return rings
}

const loadWaterBodies = async (
  eventId: string,
  lattice: Lattice,
): Promise<PolygonIndex | null> => {
  const path = join(WATER_CACHE_DIR, `${eventId}.json`)
  let payload: { elements?: Array<OverpassElement> } | null = null

  if (existsSync(path)) {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } else {
    let minLon = Infinity
    let minLat = Infinity
    let maxLon = -Infinity
    let maxLat = -Infinity
    for (const point of lattice.points) {
      minLon = Math.min(minLon, point.longitude)
      maxLon = Math.max(maxLon, point.longitude)
      minLat = Math.min(minLat, point.latitude)
      maxLat = Math.max(maxLat, point.latitude)
    }
    const bbox = `${minLat},${minLon},${maxLat},${maxLon}`
    // Relations as well as ways: any lake worth the name is a multipolygon,
    // and a way-only query silently omits the largest water body in the window.
    const query =
      `[out:json][timeout:180];(` +
      `way(${bbox})["natural"="water"];` +
      `way(${bbox})["landuse"="reservoir"];` +
      `relation(${bbox})["natural"="water"];` +
      `relation(${bbox})["landuse"="reservoir"];` +
      `);out geom;`
    // Overpass answers a 20 km box with a megabyte and returns 504 or 429 while
    // it decides whether to. The levee source already learned this; so does
    // this one, rather than reporting "no lakes here" when the answer is "ask
    // again in a moment".
    for (let attempt = 0; attempt < 4 && payload === null; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000 * attempt))
      try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          headers: { 'User-Agent': 'webmcp-playground/0.1.0 (safety-support)' },
        })
        if (!res.ok) {
          console.error(`  overpass answered ${res.status}, attempt ${attempt + 1} of 4`)
          continue
        }
        payload = (await res.json()) as typeof payload
        mkdirSync(WATER_CACHE_DIR, { recursive: true })
        writeFileSync(path, JSON.stringify(payload))
      } catch (error) {
        console.error(`  overpass request failed: ${(error as Error).message}`)
      }
    }
    if (payload === null) return null
  }

  const polygons: Array<Array<Array<readonly [number, number]>>> = []
  for (const element of payload?.elements ?? []) {
    if (element.type === 'way' && (element.geometry?.length ?? 0) >= 4) {
      polygons.push([element.geometry!.map((p) => [p.lon, p.lat] as const)])
      continue
    }
    if (element.type === 'relation' && element.members) {
      const outer = element.members
        .filter((m) => (m.role ?? 'outer') === 'outer' && (m.geometry?.length ?? 0) >= 2)
        .map((m) => m.geometry!.map((p) => [p.lon, p.lat] as const))
      for (const ring of stitchRings(outer)) polygons.push([ring])
    }
  }
  if (polygons.length === 0) {
    console.error(`  overpass returned ${payload?.elements?.length ?? 0} elements, 0 usable rings`)
    return null
  }
  return new PolygonIndex(polygons)
}

const main = async (): Promise<void> => {
  const [eventId = 'nagano', configName = 'gsi10'] = process.argv.slice(2)
  const base = CONFIGS[configName]
  if (!base) throw new Error(`unknown config: ${configName}`)

  const site = await loadObserved(eventById(eventId))
  await warmClimatology([site])
  const lattice = buildLattice(site)
  const hazard = await loadHazardMask(lattice.points)
  const run = await runModel(site, { ...base, componentZones: true })
  if (!run.pluvial || !run.fluvial) throw new Error('componentZones did not come back')

  const scored = scoreRun(lattice, run)
  const wet = Uint8Array.from(scored.classAt, (cls) => (cls === '' ? 0 : 1))
  const toEnvelope = distanceToMask(lattice, hazard.wet)
  const toObserved = distanceToMask(lattice, lattice.observed)

  const pluvialIndex = new PolygonIndex(run.pluvial.polygons, run.pluvial.classes)
  const fluvialIndex = new PolygonIndex(run.fluvial.polygons, run.fluvial.classes)
  const elevationAt = makeElevationSampler()

  const distant = new Uint8Array(wet.length)
  const near = new Uint8Array(wet.length)
  for (let i = 0; i < wet.length; i++) {
    if (wet[i] !== 1 || hazard.wet[i] === 1) continue
    if (toEnvelope[i]! > DISTANT_M) distant[i] = 1
    else near[i] = 1
  }
  const count = (mask: Uint8Array): number => mask.reduce((sum, v) => sum + v, 0)
  const distantN = count(distant)
  const nearN = count(near)

  console.log(`# Distant false positives — ${site.event.label} (\`${configName}\`)\n`)
  console.log(
    `Scored window ${(lattice.points.length * CELL_AREA_KM2).toFixed(1)} km². ` +
      `False positives against the official envelope: ${((distantN + nearN) * CELL_AREA_KM2).toFixed(1)} km², ` +
      `of which **${(distantN * CELL_AREA_KM2).toFixed(1)} km² (${percent(distantN / (distantN + nearN))})** ` +
      `lies more than ${DISTANT_M / 1000} km from any designated zone.\n`,
  )

  // ---- 1. Is it simply ground nobody assessed? --------------------------
  console.log('## 1. Designation: is this ground the reference ever had an opinion on?\n')
  console.log('| Cells | area km² | on designated ground | on undesignated ground |')
  console.log('|---|---|---|---|')
  for (const [label, mask, total] of [
    ['distant FP (>3 km)', distant, distantN],
    ['near FP (≤3 km)', near, nearN],
  ] as const) {
    let designated = 0
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1 && hazard.designated[i] === 1) designated++
    }
    console.log(
      `| ${label} | ${(total * CELL_AREA_KM2).toFixed(1)} | ` +
        `${percent(designated / (total || 1))} | ${percent(1 - designated / (total || 1))} |`,
    )
  }

  // ---- 2. Which mechanism put the water there? --------------------------
  console.log('\n## 2. Mechanism\n')
  console.log('| Cells | pluvial only | fluvial only | both |')
  console.log('|---|---|---|---|')
  for (const [label, mask, total] of [
    ['distant FP (>3 km)', distant, distantN],
    ['near FP (≤3 km)', near, nearN],
    ['true positives', Uint8Array.from(wet, (v, i) => (v === 1 && hazard.wet[i] === 1 ? 1 : 0)), 0],
  ] as const) {
    let pluvial = 0
    let fluvial = 0
    let both = 0
    let n = 0
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue
      n++
      const point = lattice.points[i]!
      const p = pluvialIndex.tagAt(point.longitude, point.latitude) !== null
      const f = fluvialIndex.tagAt(point.longitude, point.latitude) !== null
      if (p && f) both++
      else if (p) pluvial++
      else if (f) fluvial++
    }
    void total
    console.log(
      `| ${label} | ${percent(pluvial / (n || 1))} | ${percent(fluvial / (n || 1))} | ` +
        `${percent(both / (n || 1))} |`,
    )
  }

  // ---- 3. Where in the landscape? ---------------------------------------
  console.log('\n## 3. Elevation, from the same GSI mosaic the model ran on\n')
  console.log('| Cells | elevation p10 / p50 / p90 (m) | dist. to surveyed extent p50 |')
  console.log('|---|---|---|')
  for (const [label, mask] of [
    ['official envelope', hazard.wet],
    ['true positives', Uint8Array.from(wet, (v, i) => (v === 1 && hazard.wet[i] === 1 ? 1 : 0))],
    ['near FP (≤3 km)', near],
    ['distant FP (>3 km)', distant],
  ] as const) {
    const elevations: Array<number> = []
    const distances: Array<number> = []
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue
      const point = lattice.points[i]!
      elevations.push(elevationAt(point.longitude, point.latitude))
      distances.push(toObserved[i]!)
    }
    const sortedDistance = distances.sort((a, b) => a - b)
    const median = sortedDistance[Math.floor(sortedDistance.length / 2)] ?? NaN
    console.log(`| ${label} | ${quantiles(elevations)} | ${(median / 1000).toFixed(1)} km |`)
  }

  // ---- 3b. Is it standing water? ----------------------------------------
  //
  // The elevation cut says this water sits hundreds of metres above the river.
  // There is one landform that does that and is permanently wet, so ask
  // OpenStreetMap directly rather than inferring it from the blob list.
  const water = await loadWaterBodies(site.event.id, lattice)
  if (water) {
    console.log('\n## 3b. How much of it is permanent water?\n')
    console.log('| Cells | area km² | inside a mapped lake or reservoir |')
    console.log('|---|---|---|')
    for (const [label, mask, total] of [
      ['distant FP (>3 km)', distant, distantN],
      ['near FP (≤3 km)', near, nearN],
    ] as const) {
      let inWater = 0
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== 1) continue
        const point = lattice.points[i]!
        if (water.contains(point.longitude, point.latitude)) inWater++
      }
      console.log(
        `| ${label} | ${(total * CELL_AREA_KM2).toFixed(1)} | ` +
          `**${percent(inWater / (total || 1))}** |`,
      )
    }
    // What would it be worth to stop reporting standing water as flood?
    //
    // A lake is not land that floods; it is water. The official envelope treats
    // it that way and a life-safety answer should too — telling someone a lake
    // will be inundated is not a warning. Masking the *normal pool* leaves any
    // genuine flooding beyond the shoreline untouched, so this is a floor on
    // the gain, not a trick: only cells the model calls wet that are already
    // permanently wet are removed.
    let tp = 0
    let fp = 0
    let tpInWater = 0
    let fpInWater = 0
    for (let i = 0; i < wet.length; i++) {
      if (wet[i] !== 1) continue
      const point = lattice.points[i]!
      const isWater = water.contains(point.longitude, point.latitude)
      if (hazard.wet[i] === 1) {
        tp++
        if (isWater) tpInWater++
      } else {
        fp++
        if (isWater) fpInWater++
      }
    }
    const before = tp / (tp + fp || 1)
    const after = (tp - tpInWater) / (tp - tpInWater + (fp - fpInWater) || 1)
    console.log('\n## 3c. What masking permanent water would buy\n')
    console.log(
      `| all FP that is standing water | precision now | precision masked | Δ |\n` +
        `|---|---|---|---|\n` +
        `| ${(fpInWater * CELL_AREA_KM2).toFixed(1)} km² of ${(fp * CELL_AREA_KM2).toFixed(1)} km² ` +
        `(${percent(fpInWater / (fp || 1))}) | ${percent(before)} | **${percent(after)}** | ` +
        `+${((after - before) * 100).toFixed(1)} |`,
    )
  } else {
    console.log('\n## 3b. How much of it is permanent water?\n\nOverpass unavailable; skipped.')
  }

  // ---- 4. One place or everywhere? --------------------------------------
  const clusters = clustersOf(lattice, distant)
  const bigEnough = clusters.filter((c) => c.size >= 10)
  console.log('\n## 4. Clustering\n')
  console.log(
    `${clusters.length} connected blobs; ${bigEnough.length} of them are 0.1 km² or larger, ` +
      `and those hold ${percent(
        bigEnough.reduce((sum, c) => sum + c.size, 0) / (distantN || 1),
      )} of the distant area.\n`,
  )
  console.log('| Rank | km² | centroid | elevation m |')
  console.log('|---|---|---|---|')
  for (const [i, cluster] of clusters.slice(0, 8).entries()) {
    console.log(
      `| ${i + 1} | ${(cluster.size * CELL_AREA_KM2).toFixed(2)} | ` +
        `${cluster.lat.toFixed(4)}, ${cluster.lon.toFixed(4)} | ` +
        `${elevationAt(cluster.lon, cluster.lat).toFixed(0)} |`,
    )
  }
}

if (import.meta.main) {
  await main()
}
