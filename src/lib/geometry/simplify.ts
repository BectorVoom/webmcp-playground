import simplify from '@turf/simplify'
import type { Feature, Geometry, MultiPolygon, Polygon, Position } from 'geojson'
import type { FloodZone } from '../../domain/hazard'

export const countGeometryVertices = (geom: Geometry | undefined): number => {
  if (!geom) return 0
  switch (geom.type) {
    case 'Point':
      return 1
    case 'MultiPoint':
      return geom.coordinates.length
    case 'LineString':
      return geom.coordinates.length
    case 'MultiLineString':
      return geom.coordinates.reduce((sum, line) => sum + line.length, 0)
    case 'Polygon':
      return geom.coordinates.reduce((sum, ring) => sum + ring.length, 0)
    case 'MultiPolygon':
      return geom.coordinates.reduce(
        (sum, poly) => sum + poly.reduce((ringSum, ring) => ringSum + ring.length, 0),
        0,
      )
    case 'GeometryCollection':
      return geom.geometries.reduce((sum, g) => sum + countGeometryVertices(g), 0)
  }
}

export const countZonesVertices = (zones: ReadonlyArray<FloodZone>): number =>
  zones.reduce((sum, z) => sum + countGeometryVertices(z.geometry), 0)

export interface SimplifyResult {
  readonly zones: ReadonlyArray<FloodZone>
  readonly verticesIn: number
  readonly verticesOut: number
  readonly toleranceUsed: number
}

export const MAP_VERTEX_BUDGET = 20_000
export const ROUTING_VERTEX_BUDGET = 1_000

const EARTH_RADIUS_KM = 6371.0088
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

/** Spherical-excess area of a ring, km². Sign is dropped: winding order is not the question here. */
const ringAreaKm2 = (ring: ReadonlyArray<Position>): number => {
  if (ring.length < 3) return 0
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i]!
    const [lon2, lat2] = ring[(i + 1) % ring.length]!
    total += toRadians(lon2! - lon1!) * (2 + Math.sin(toRadians(lat1!)) + Math.sin(toRadians(lat2!)))
  }
  return Math.abs((total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2)
}

export interface PartTrimResult {
  readonly zones: ReadonlyArray<FloodZone>
  readonly partsIn: number
  readonly partsOut: number
  /** Mapped area removed from the drawing, km². Reported because it is real water. */
  readonly areaDroppedKm2: number
}

/**
 * Drops the smallest disjoint parts until the geometry fits a vertex budget.
 *
 * Simplification alone cannot get there, and the reason is structural rather than a matter of
 * tolerance: Douglas-Peucker will not take a ring below four points, so a extent of *n* disjoint
 * parts costs ~5n vertices at any tolerance whatsoever. A 20 km flood-model run vectorises into
 * seven thousand parts — the extent comes off a raster and shallow water is speckle — which is
 * 38 000 vertices against a 20 000 budget with nothing left to simplify away. This was recorded in
 * the tech-debt log as a known property of the approach; it becomes a defect the moment something
 * actually tries to draw that geometry.
 *
 * So the parts themselves go, smallest first. At map scale a fragment below a pixel conveys nothing
 * anyway — but it is still mapped water, so how much was removed is returned rather than swallowed.
 *
 * **The largest part of every zone is kept**, whatever the budget. A depth band that vanished
 * entirely would take its legend entry and its whole meaning with it, and "no extreme water here"
 * is a very different statement from "the extreme water was too speckled to draw".
 */
export const dropSmallestPartsToBudget = (
  zones: ReadonlyArray<FloodZone>,
  budget = MAP_VERTEX_BUDGET,
): PartTrimResult => {
  interface Part {
    readonly zoneIndex: number
    readonly rings: ReadonlyArray<ReadonlyArray<Position>>
    readonly areaKm2: number
    readonly vertices: number
  }

  const parts: Array<Part> = []
  zones.forEach((zone, zoneIndex) => {
    const polygons =
      zone.geometry.type === 'MultiPolygon'
        ? (zone.geometry.coordinates as Array<Array<Array<Position>>>)
        : [zone.geometry.coordinates as Array<Array<Position>>]
    for (const rings of polygons) {
      parts.push({
        zoneIndex,
        rings,
        areaKm2: ringAreaKm2(rings[0] ?? []),
        vertices: rings.reduce((sum, ring) => sum + ring.length, 0),
      })
    }
  })

  const partsIn = parts.length
  const totalVertices = parts.reduce((sum, part) => sum + part.vertices, 0)
  if (totalVertices <= budget || partsIn === 0) {
    return { zones, partsIn, partsOut: partsIn, areaDroppedKm2: 0 }
  }

  // The one part per zone that is never dropped.
  const largestOfZone = new Map<number, Part>()
  for (const part of parts) {
    const current = largestOfZone.get(part.zoneIndex)
    if (!current || part.areaKm2 > current.areaKm2) largestOfZone.set(part.zoneIndex, part)
  }

  const kept = new Set<Part>(largestOfZone.values())
  let vertices = [...kept].reduce((sum, part) => sum + part.vertices, 0)

  // Largest first, so what survives is the water most worth seeing.
  for (const part of [...parts].sort((a, b) => b.areaKm2 - a.areaKm2)) {
    if (kept.has(part)) continue
    if (vertices + part.vertices > budget) continue
    kept.add(part)
    vertices += part.vertices
  }

  const areaDroppedKm2 = parts
    .filter((part) => !kept.has(part))
    .reduce((sum, part) => sum + part.areaKm2, 0)

  const trimmed = zones.map((zone, zoneIndex) => {
    const rings = parts.filter((part) => part.zoneIndex === zoneIndex && kept.has(part)).map((p) => p.rings)
    return {
      ...zone,
      geometry: { type: 'MultiPolygon' as const, coordinates: rings as Array<Array<Array<Position>>> },
    }
  })

  return { zones: trimmed, partsIn, partsOut: kept.size, areaDroppedKm2 }
}

export interface FitResult extends SimplifyResult {
  readonly partsIn: number
  readonly partsOut: number
  readonly areaDroppedKm2: number
}

/** A closed ring cannot be simplified below four points, so this is the floor per part. */
const MIN_RING_VERTICES = 4

const countRings = (zones: ReadonlyArray<FloodZone>): number =>
  zones.reduce((sum, zone) => {
    const polygons =
      zone.geometry.type === 'MultiPolygon'
        ? (zone.geometry.coordinates as Array<unknown>)
        : [zone.geometry.coordinates]
    return sum + polygons.length
  }, 0)

/**
 * Gets zone geometry inside a rendering budget, by both means available.
 *
 * Prefer simplification: moving a vertex costs detail, losing a polygon costs a place. But there
 * are extents simplification provably cannot fit — with *n* parts the floor is 4n vertices at any
 * tolerance — and running the tolerance ladder against those is fifteen passes over thousands of
 * already-minimal rings for an identical result. Measured at 6 000 parts, that was eight seconds.
 *
 * So the order depends on whether simplification could possibly succeed. When it could, it goes
 * first and usually finishes the job. When the part count alone rules it out, the parts are
 * trimmed first and the simplifier then works on the few that will actually be drawn.
 */
export const fitZonesToMapBudget = (
  zones: ReadonlyArray<FloodZone>,
  budget = MAP_VERTEX_BUDGET,
): FitResult => {
  const verticesIn = countZonesVertices(zones)
  const simplificationCanFit = countRings(zones) * MIN_RING_VERTICES <= budget

  if (simplificationCanFit) {
    const simplified = simplifyZonesToBudget(zones, budget)
    const trimmed = dropSmallestPartsToBudget(simplified.zones, budget)
    return {
      zones: trimmed.zones,
      verticesIn,
      verticesOut: countZonesVertices(trimmed.zones),
      toleranceUsed: simplified.toleranceUsed,
      partsIn: trimmed.partsIn,
      partsOut: trimmed.partsOut,
      areaDroppedKm2: trimmed.areaDroppedKm2,
    }
  }

  const trimmed = dropSmallestPartsToBudget(zones, budget)
  const simplified = simplifyZonesToBudget(trimmed.zones, budget)
  return {
    zones: simplified.zones,
    verticesIn,
    verticesOut: countZonesVertices(simplified.zones),
    toleranceUsed: simplified.toleranceUsed,
    partsIn: trimmed.partsIn,
    partsOut: trimmed.partsOut,
    areaDroppedKm2: trimmed.areaDroppedKm2,
  }
}

/**
 * Simplifies zone geometries using vertex-budget search (R2.6, N5).
 * Starts at tolerance 1e-5 and doubles until within budget or max iterations reached.
 */
export const simplifyZonesToBudget = (
  zones: ReadonlyArray<FloodZone>,
  budget = MAP_VERTEX_BUDGET,
  initialTolerance = 0.00001,
  maxIterations = 15,
): SimplifyResult => {
  const verticesIn = countZonesVertices(zones)
  if (verticesIn <= budget || zones.length === 0) {
    return {
      zones,
      verticesIn,
      verticesOut: verticesIn,
      toleranceUsed: 0,
    }
  }

  let tolerance = initialTolerance
  let currentZones = zones
  let currentVertices = verticesIn

  for (let iter = 0; iter < maxIterations; iter++) {
    const simplified = currentZones.map((zone) => {
      const feat: Feature<Polygon | MultiPolygon> = {
        type: 'Feature',
        properties: {},
        geometry: zone.geometry,
      }
      try {
        const sim = simplify(feat, { tolerance, highQuality: false, mutate: false })
        return {
          ...zone,
          geometry: sim.geometry as Polygon | MultiPolygon,
        }
      } catch {
        return zone
      }
    })

    currentVertices = countZonesVertices(simplified)
    currentZones = simplified

    if (currentVertices <= budget) {
      break
    }
    tolerance *= 2
  }

  return {
    zones: currentZones,
    verticesIn,
    verticesOut: currentVertices,
    toleranceUsed: tolerance,
  }
}
