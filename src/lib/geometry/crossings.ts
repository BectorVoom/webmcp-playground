import lineIntersect from '@turf/line-intersect'
import lineSlice from '@turf/line-slice'
import length from '@turf/length'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point, lineString } from '@turf/helpers'
import type { Feature, LineString, Polygon, MultiPolygon } from 'geojson'
import type { FloodZone } from '../../domain/hazard'
import type { CrossingReport } from '../../domain/routing'

/**
 * Assesses route geometry against flood zones to count crossings and find first crossing distance (R3.6).
 */
export const assessRouteCrossings = (
  routeGeometry: LineString,
  zones: ReadonlyArray<FloodZone>,
  hasFloodCoverage = true,
): CrossingReport => {
  if (!hasFloodCoverage) {
    return { count: 0, firstAtMetres: null, assessed: false }
  }

  if (zones.length === 0 || routeGeometry.coordinates.length < 2) {
    return { count: 0, firstAtMetres: null, assessed: true }
  }

  const routeFeature = lineString(routeGeometry.coordinates)
  const startCoord = routeGeometry.coordinates[0]
  if (!startCoord) {
    return { count: 0, firstAtMetres: null, assessed: true }
  }
  const startPt = point(startCoord)

  let startInZone = false
  for (const zone of zones) {
    const feat: Feature<Polygon | MultiPolygon> = {
      type: 'Feature',
      properties: {},
      geometry: zone.geometry,
    }
    if (booleanPointInPolygon(startPt, feat)) {
      startInZone = true
      break
    }
  }

  const intersections: Array<[number, number]> = []

  for (const zone of zones) {
    const polyFeature: Feature<Polygon | MultiPolygon> = {
      type: 'Feature',
      properties: {},
      geometry: zone.geometry,
    }
    try {
      const isects = lineIntersect(routeFeature, polyFeature)
      for (const feat of isects.features) {
        if (feat.geometry.coordinates) {
          intersections.push(feat.geometry.coordinates as [number, number])
        }
      }
    } catch {
      // ignore topology anomalies
    }
  }

  if (startInZone) {
    // If starting inside a zone, first crossing is at 0m, count includes origin + subsequent boundary entries
    return {
      count: Math.max(1, intersections.length),
      firstAtMetres: 0,
      assessed: true,
    }
  }

  if (intersections.length === 0) {
    return {
      count: 0,
      firstAtMetres: null,
      assessed: true,
    }
  }

  // Find the minimum distance along route to any intersection point
  let minDistanceMetres = Number.POSITIVE_INFINITY

  for (const isectCoord of intersections) {
    try {
      const isectPt = point(isectCoord)
      const sliced = lineSlice(startPt, isectPt, routeFeature)
      const distMetres = length(sliced, { units: 'meters' })
      if (distMetres < minDistanceMetres) {
        minDistanceMetres = distMetres
      }
    } catch {
      // Fallback
    }
  }

  return {
    count: intersections.length,
    firstAtMetres: Number.isFinite(minDistanceMetres) ? Math.round(minDistanceMetres) : null,
    assessed: true,
  }
}
