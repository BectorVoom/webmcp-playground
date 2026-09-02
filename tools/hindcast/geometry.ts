/**
 * Geometry for the hindcast harness: spherical polygon area, and a bucketed
 * point-in-polygon index.
 *
 * The index exists because scoring is a brute-force question — a hundred
 * thousand lattice points against several hundred polygons — and doing it
 * through turf one polygon at a time takes minutes per event. Ray casting over
 * a uniform bucket grid takes seconds, which is what makes a whole sweep
 * affordable.
 */

export type Ring = ReadonlyArray<readonly [number, number]>
/** Outer ring first, holes after, as in GeoJSON. */
export type Polygon = ReadonlyArray<Ring>
export type BBox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number]

const EARTH_RADIUS_KM = 6371.0088

/**
 * Signed spherical area of a ring (Chamberlain & Duquette 2007). Signed so a
 * hole subtracts; callers that only want magnitude take the absolute value.
 */
export const ringAreaKm2 = (ring: Ring): number => {
  if (ring.length < 3) return 0
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!
    const [x2, y2] = ring[(i + 1) % ring.length]!
    total +=
      ((x2 - x1) * Math.PI) / 180 *
      (2 + Math.sin((y1 * Math.PI) / 180) + Math.sin((y2 * Math.PI) / 180))
  }
  return (total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2
}

export const polygonAreaKm2 = (polygon: Polygon): number => {
  if (polygon.length === 0) return 0
  let area = Math.abs(ringAreaKm2(polygon[0]!))
  for (let i = 1; i < polygon.length; i++) area -= Math.abs(ringAreaKm2(polygon[i]!))
  return area
}

/**
 * Sum of polygon areas. Correct only where the polygons do not overlap, which
 * is true of both the GSI references and the model's dissolved zones; anything
 * that needs an honest union goes through the lattice instead.
 */
export const totalAreaKm2 = (polygons: ReadonlyArray<Polygon>): number =>
  polygons.reduce((sum, p) => sum + polygonAreaKm2(p), 0)

export const polygonBBox = (polygon: Polygon): BBox => {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const ring of polygon) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
    }
  }
  return [minLon, minLat, maxLon, maxLat]
}

export const unionBBox = (boxes: ReadonlyArray<BBox>): BBox => {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const [a, b, c, d] of boxes) {
    if (a < minLon) minLon = a
    if (b < minLat) minLat = b
    if (c > maxLon) maxLon = c
    if (d > maxLat) maxLat = d
  }
  return [minLon, minLat, maxLon, maxLat]
}

/** Even-odd ray cast across every ring, so holes fall out for free. */
const pointInPolygon = (lon: number, lat: number, polygon: Polygon): boolean => {
  let inside = false
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
  }
  return inside
}

const GRID = 96

/**
 * Point membership against a set of polygons, bucketed on a uniform grid so a
 * query tests only the polygons whose bounding box could contain it.
 */
export class PolygonIndex {
  private readonly polygons: ReadonlyArray<Polygon>
  private readonly boxes: ReadonlyArray<BBox>
  private readonly buckets: ReadonlyArray<ReadonlyArray<number>>
  readonly bbox: BBox
  /** Parallel to `polygons`; whatever the caller wants to attribute a hit to. */
  private readonly tags: ReadonlyArray<string>

  constructor(polygons: ReadonlyArray<Polygon>, tags?: ReadonlyArray<string>) {
    this.polygons = polygons
    this.tags = tags ?? polygons.map(() => '')
    this.boxes = polygons.map(polygonBBox)
    this.bbox = this.boxes.length ? unionBBox(this.boxes) : [0, 0, 0, 0]
    const buckets: Array<Array<number>> = Array.from({ length: GRID * GRID }, () => [])
    const [minLon, minLat, maxLon, maxLat] = this.bbox
    const lonSpan = maxLon - minLon || 1e-9
    const latSpan = maxLat - minLat || 1e-9
    this.boxes.forEach((box, index) => {
      const x0 = Math.max(0, Math.floor(((box[0] - minLon) / lonSpan) * GRID))
      const x1 = Math.min(GRID - 1, Math.floor(((box[2] - minLon) / lonSpan) * GRID))
      const y0 = Math.max(0, Math.floor(((box[1] - minLat) / latSpan) * GRID))
      const y1 = Math.min(GRID - 1, Math.floor(((box[3] - minLat) / latSpan) * GRID))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) buckets[y * GRID + x]!.push(index)
      }
    })
    this.buckets = buckets
  }

  /** Index of the first polygon containing the point, or -1. */
  find(lon: number, lat: number): number {
    const [minLon, minLat, maxLon, maxLat] = this.bbox
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return -1
    const lonSpan = maxLon - minLon || 1e-9
    const latSpan = maxLat - minLat || 1e-9
    const x = Math.min(GRID - 1, Math.max(0, Math.floor(((lon - minLon) / lonSpan) * GRID)))
    const y = Math.min(GRID - 1, Math.max(0, Math.floor(((lat - minLat) / latSpan) * GRID)))
    for (const index of this.buckets[y * GRID + x]!) {
      const box = this.boxes[index]!
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue
      if (pointInPolygon(lon, lat, this.polygons[index]!)) return index
    }
    return -1
  }

  contains(lon: number, lat: number): boolean {
    return this.find(lon, lat) >= 0
  }

  /** Tag of the first containing polygon, or null. */
  tagAt(lon: number, lat: number): string | null {
    const index = this.find(lon, lat)
    return index >= 0 ? this.tags[index]! : null
  }

  get size(): number {
    return this.polygons.length
  }
}

/** GeoJSON Polygon or MultiPolygon to the flat polygon list used here. */
export const geometryToPolygons = (
  geometry: { type: string; coordinates: unknown },
): ReadonlyArray<Polygon> => {
  if (geometry.type === 'Polygon') return [geometry.coordinates as Polygon]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as ReadonlyArray<Polygon>
  return []
}
