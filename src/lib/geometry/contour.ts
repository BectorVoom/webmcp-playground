import union from '@turf/union'
import { featureCollection, polygon } from '@turf/helpers'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'
import type { BBox } from '../../domain/geo'
import type { DepthBand, FloodZone, HazardClass, ZoneKind } from '../../domain/hazard'
import type { Provenance } from '../../domain/provenance'
import { tileBBox } from './tiles'

export interface VectorisedTileZone {
  readonly hazardClass: HazardClass
  readonly depth?: DepthBand
  readonly geometry: Polygon | MultiPolygon
}

/**
 * Converts pixel coords (px, py) within a tile of (width, height) to WGS84 [lon, lat].
 */
export const pixelToWgs84 = (
  px: number,
  py: number,
  width: number,
  height: number,
  [minLon, minLat, maxLon, maxLat]: BBox,
): [number, number] => {
  const lon = minLon + (px / width) * (maxLon - minLon)
  const lat = maxLat - (py / height) * (maxLat - minLat)
  return [lon, lat]
}

/**
 * The ground size of one vectorised cell.
 *
 * A GSI tile is 256 px however much ground it covers, so at z14 a pixel is about 9 m — far finer
 * than any question asked of this data, and ruinously expensive to vectorise: a single tile around
 * Fukui Station holds some 4 700 separate pixel runs, which become 12 000 polygon vertices before
 * the layer is simplified back down to the 20 000-vertex budget for the whole map (N5). Working at
 * ~40 m cells costs about a tenth of that and is still an order of magnitude finer than the 110 m
 * coordinate rounding these queries already use (R1.6).
 */
export const DEFAULT_CELL_METRES = 40

/** Higher means deeper water. Used so a coarser cell can never report shallower than its source. */
const SEVERITY: Record<HazardClass, number> = {
  unclassified: 1,
  low: 2,
  moderate: 3,
  high: 4,
  extreme: 5,
}

const METRES_PER_DEGREE_LAT = 111_320

/** Ground size of one pixel, from the tile's own extent — correct at any zoom, at any latitude. */
const pixelMetres = (width: number, [minLon, minLat, maxLon, maxLat]: BBox): number => {
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180)
  const widthMetres = Math.abs(maxLon - minLon) * METRES_PER_DEGREE_LAT * Math.cos(midLat)
  return widthMetres / Math.max(1, width)
}

const deeper = (a: DepthBand | undefined, b: DepthBand | undefined): DepthBand | undefined => {
  if (!a) return b
  if (!b) return a
  return b.minMetres > a.minMetres ? b : a
}

interface Grid {
  readonly grid: ReadonlyArray<HazardClass | null>
  readonly depths: ReadonlyArray<DepthBand | undefined>
  readonly width: number
  readonly height: number
}

/**
 * Reduces the grid to cells of `factor` pixels a side, keeping the **most severe** class in each
 * block along with that class's depth.
 *
 * Most severe rather than most common on purpose: coarsening must never turn 5 m of water into
 * 0.5 m because it was outnumbered. The error it does introduce — a cell reading deeper than parts
 * of it really are — is the direction a reader can act on safely.
 */
const coarsen = (source: Grid, factor: number): Grid => {
  if (factor <= 1) return source
  const { grid, depths, width, height } = source
  const w = Math.ceil(width / factor)
  const h = Math.ceil(height / factor)
  const out: Array<HazardClass | null> = new Array(w * h).fill(null)
  const outDepths: Array<DepthBand | undefined> = new Array(w * h).fill(undefined)

  for (let y = 0; y < height; y++) {
    const outRow = Math.floor(y / factor) * w
    for (let x = 0; x < width; x++) {
      const cls = grid[y * width + x]
      if (!cls) continue
      const i = outRow + Math.floor(x / factor)
      const prev = out[i]
      const depth = depths[y * width + x]
      if (!prev || SEVERITY[cls] > SEVERITY[prev]) {
        out[i] = cls
        outDepths[i] = depth
      } else if (SEVERITY[cls] === SEVERITY[prev]) {
        // Same class, deeper band: 'extreme' spans 5–10 m through 20 m+, so severity alone cannot
        // decide which of two cells to keep the depth from.
        outDepths[i] = deeper(outDepths[i], depth)
      }
    }
  }

  return { grid: out, depths: outDepths, width: w, height: h }
}

interface Span {
  readonly xStart: number
  readonly xEnd: number
  readonly y: number
}

interface Rect {
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
}

/** One entry per class: its runs, and the deepest band seen anywhere in them. */
interface ClassRuns {
  spans: Array<Span>
  depth?: DepthBand
}

/** Horizontal runs of one class, per row. */
const runsByClass = ({ grid, depths, width, height }: Grid): Map<HazardClass, ClassRuns> => {
  const byClass = new Map<HazardClass, ClassRuns>()

  const entryFor = (cls: HazardClass): ClassRuns => {
    const existing = byClass.get(cls)
    if (existing) return existing
    const created: ClassRuns = { spans: [] }
    byClass.set(cls, created)
    return created
  }

  for (let y = 0; y < height; y++) {
    let current: HazardClass | null = null
    let start = 0
    for (let x = 0; x <= width; x++) {
      const cls = x === width ? null : (grid[y * width + x] ?? null)
      if (cls !== null) {
        // Deepest band anywhere in the class, sampled per cell rather than per run: one hazard
        // class covers several bands — 'extreme' is 5–10 m, 10–20 m and 20 m+ at once — so a run
        // can start in the shallowest of them and still contain the deepest.
        const entry = entryFor(cls)
        entry.depth = deeper(entry.depth, depths[y * width + x])
      }
      if (cls === current) continue
      if (current !== null) entryFor(current).spans.push({ xStart: start, xEnd: x, y })
      current = cls
      start = x
    }
  }

  return byClass
}

/**
 * Merges runs that share a start and end column and sit on consecutive rows into one rectangle.
 *
 * Free, exact, and it removes most of the input before any polygon clipping happens — a solid
 * block 200 rows deep arrives as 200 runs and leaves as one rectangle.
 */
export const coalesceRuns = (spans: ReadonlyArray<Span>): ReadonlyArray<Rect> => {
  const columns = new Map<string, Array<Span>>()
  for (const span of spans) {
    const key = `${span.xStart}:${span.xEnd}`
    const group = columns.get(key) ?? []
    group.push(span)
    columns.set(key, group)
  }

  const rects: Array<Rect> = []
  for (const group of columns.values()) {
    group.sort((a, b) => a.y - b.y)
    let head = group[0]!
    let y1 = head.y + 1
    for (let i = 1; i < group.length; i++) {
      const span = group[i]!
      if (span.y === y1) {
        y1 = span.y + 1
        continue
      }
      rects.push({ x0: head.xStart, x1: head.xEnd, y0: head.y, y1 })
      head = span
      y1 = span.y + 1
    }
    rects.push({ x0: head.xStart, x1: head.xEnd, y0: head.y, y1 })
  }
  return rects
}

const rectToPolygon = (
  rect: Rect,
  width: number,
  height: number,
  bbox: BBox,
): Feature<Polygon> => {
  const nw = pixelToWgs84(rect.x0, rect.y0, width, height, bbox)
  const ne = pixelToWgs84(rect.x1, rect.y0, width, height, bbox)
  const se = pixelToWgs84(rect.x1, rect.y1, width, height, bbox)
  const sw = pixelToWgs84(rect.x0, rect.y1, width, height, bbox)
  return polygon([[nw, ne, se, sw, nw]])
}

/**
 * Dissolves many polygons into one geometry with a single clipper pass.
 *
 * The shape of this function is the whole bug fix. It used to be a loop that called `union` once
 * per polygon against a running accumulator, so the accumulator was re-clipped from scratch every
 * iteration: quadratic in the number of pieces, and with ~4 700 pieces in one real GSI tile the
 * flood query never returned at all and the map layer was simply never set. One call over the
 * whole collection does the same work in a single sweep, in about 40 ms.
 *
 * If the clipper fails, the pieces are returned as a MultiPolygon rather than dropped. That keeps
 * the mapped area truthful — it only leaves the internal edges between pieces undissolved.
 */
const dissolve = (parts: ReadonlyArray<Feature<Polygon>>): Polygon | MultiPolygon | null => {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!.geometry

  const asMultiPolygon = (): MultiPolygon => ({
    type: 'MultiPolygon',
    coordinates: parts.map((part) => part.geometry.coordinates as Array<Array<Position>>),
  })

  try {
    const merged = union(featureCollection([...parts]))
    return merged?.geometry ?? asMultiPolygon()
  } catch {
    return asMultiPolygon()
  }
}

export interface VectoriseOptions {
  /** Ground size of one vectorised cell. Defaults to `DEFAULT_CELL_METRES`. */
  readonly cellMetres?: number
}

/**
 * Vectorises a classified raster tile into one geometry per hazard class (R2.4).
 */
export const vectoriseTileGrid = (
  grid: Array<HazardClass | null>,
  depthGrid: Array<DepthBand | undefined>,
  width: number,
  height: number,
  bbox: BBox,
  options: VectoriseOptions = {},
): ReadonlyArray<VectorisedTileZone> => {
  const cellMetres = options.cellMetres ?? DEFAULT_CELL_METRES
  const factor = Math.max(1, Math.floor(cellMetres / Math.max(pixelMetres(width, bbox), 0.0001)))
  const working = coarsen({ grid, depths: depthGrid, width, height }, factor)

  const results: Array<VectorisedTileZone> = []
  for (const [hazardClass, { spans, depth }] of runsByClass(working)) {
    const rects = coalesceRuns(spans)
    const parts = rects.map((rect) => rectToPolygon(rect, working.width, working.height, bbox))
    const geometry = dissolve(parts)
    if (geometry) results.push({ hazardClass, depth, geometry })
  }
  return results
}

/**
 * Full vectorisation pipeline: takes classified raster tiles and converts to FloodZone records (R2.4).
 *
 * Geometries are collected across every tile and dissolved once per class at the end, for the same
 * reason `dissolve` exists: unioning tile-by-tile re-clips a growing accumulator once per tile.
 */
export const rasterTilesToFloodZones = (
  tiles: ReadonlyArray<{
    readonly z: number
    readonly x: number
    readonly y: number
    readonly grid: Array<HazardClass | null>
    readonly depthGrid: Array<DepthBand | undefined>
    readonly width: number
    readonly height: number
  }>,
  provenance: Provenance,
  designEvent = 'L2 assumed maximum',
  options: VectoriseOptions = {},
): ReadonlyArray<FloodZone> => {
  const kind: ZoneKind = { kind: 'scenario', designEvent }

  const partsByClass = new Map<
    HazardClass,
    { parts: Array<Feature<Polygon>>; depth?: DepthBand }
  >()

  for (const tile of tiles) {
    const bbox = tileBBox(tile.x, tile.y, tile.z)
    for (const zone of vectoriseTileGrid(
      tile.grid,
      tile.depthGrid,
      tile.width,
      tile.height,
      bbox,
      options,
    )) {
      const entry = partsByClass.get(zone.hazardClass) ?? { parts: [] }
      if (zone.geometry.type === 'Polygon') {
        entry.parts.push(polygon(zone.geometry.coordinates))
      } else {
        for (const rings of zone.geometry.coordinates) entry.parts.push(polygon(rings))
      }
      entry.depth = deeper(entry.depth, zone.depth)
      partsByClass.set(zone.hazardClass, entry)
    }
  }

  const zones: Array<FloodZone> = []
  for (const [hazardClass, { parts, depth }] of partsByClass) {
    const geometry = dissolve(parts)
    if (!geometry) continue
    zones.push({
      id: `scenario-${hazardClass}`,
      kind,
      hazardClass,
      depth,
      geometry,
      provenance,
    })
  }
  return zones
}
