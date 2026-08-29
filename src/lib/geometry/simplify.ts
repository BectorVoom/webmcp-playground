import simplify from '@turf/simplify'
import type { Feature, Geometry, MultiPolygon, Polygon } from 'geojson'
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
