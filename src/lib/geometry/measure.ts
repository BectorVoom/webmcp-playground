import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import nearestPointOnLine from '@turf/nearest-point-on-line'
import distance from '@turf/distance'
import bearing from '@turf/bearing'
import { point, lineString } from '@turf/helpers'
import type { LonLat } from '../../domain/geo'
import { bearingToDirection } from '../../domain/geo'
import type { FloodZone, NearestZoneEdge } from '../../domain/hazard'
import type { RiskState } from '../../domain/places'

export const isPointInZone = (at: LonLat, zone: FloodZone): boolean => {
  const pt = point([at.longitude, at.latitude])
  return booleanPointInPolygon(pt, zone.geometry)
}

export const isPointInGeometry = (
  coords: LonLat | [number, number],
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean => {
  const pt = Array.isArray(coords)
    ? point(coords)
    : point([coords.longitude, coords.latitude])
  return booleanPointInPolygon(pt, geometry)
}

export const findContainingZone = (
  at: LonLat,
  zones: ReadonlyArray<FloodZone>,
): FloodZone | null => {
  for (const zone of zones) {
    if (isPointInZone(at, zone)) {
      return zone
    }
  }
  return null
}

export const findNearestZoneEdge = (
  at: LonLat,
  zones: ReadonlyArray<FloodZone>,
): NearestZoneEdge | null => {
  if (zones.length === 0) return null

  const pt = point([at.longitude, at.latitude])
  let minDistanceKm = Infinity
  let bestBearingDeg = 0
  let bestHazardClass = zones[0]!.hazardClass

  for (const zone of zones) {
    const lines: Array<ReturnType<typeof lineString>> = []
    if (zone.geometry.type === 'Polygon') {
      for (const ring of zone.geometry.coordinates) {
        if (ring.length >= 2) {
          lines.push(lineString(ring))
        }
      }
    } else if (zone.geometry.type === 'MultiPolygon') {
      for (const poly of zone.geometry.coordinates) {
        for (const ring of poly) {
          if (ring.length >= 2) {
            lines.push(lineString(ring))
          }
        }
      }
    }

    for (const line of lines) {
      try {
        const nearestPt = nearestPointOnLine(line, pt)
        const dKm = distance(pt, nearestPt, { units: 'kilometers' })
        if (dKm < minDistanceKm) {
          minDistanceKm = dKm
          bestHazardClass = zone.hazardClass
          const b = bearing(pt, nearestPt)
          bestBearingDeg = Math.round(((b % 360) + 360) % 360)
        }
      } catch {
        // Degenerate segment ignored
      }
    }
  }

  if (minDistanceKm === Infinity) return null

  return {
    metres: Math.round(minDistanceKm * 1000),
    bearing: bestBearingDeg,
    direction: bearingToDirection(bestBearingDeg),
    hazardClass: bestHazardClass,
  }
}

export interface FacilityRiskAssessment {
  readonly risk: RiskState
  readonly matchingZone: FloodZone | null
}

export const assessFacilityRisk = (
  facilityAt: LonLat,
  zones: ReadonlyArray<FloodZone>,
  hasCoverage: boolean,
): FacilityRiskAssessment => {
  if (!hasCoverage) {
    return { risk: 'unknown', matchingZone: null }
  }

  const containing = findContainingZone(facilityAt, zones)
  if (containing !== null) {
    return { risk: 'at_risk', matchingZone: containing }
  }

  return { risk: 'clear', matchingZone: null }
}
