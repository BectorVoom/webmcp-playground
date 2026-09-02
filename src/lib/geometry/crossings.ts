import lineIntersect from '@turf/line-intersect'
import lineSlice from '@turf/line-slice'
import length from '@turf/length'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point, lineString } from '@turf/helpers'
import type { Feature, LineString, Polygon, MultiPolygon } from 'geojson'
import type { FloodZone } from '../../domain/hazard'
import type { CrossingReport } from '../../domain/routing'
import { metresBetween } from './directions'

/**
 * Spacing of the exposure samples. Twenty metres is fine enough that no realistic flooded stretch
 * of street is missed and coarse enough that a four-kilometre walk stays a couple of hundred
 * point-in-polygon tests rather than tens of thousands.
 */
const EXPOSURE_SAMPLE_METRES = 20

/**
 * How much of the path runs inside flood water, by walking it in fixed steps and asking at each
 * one whether it is in a zone.
 *
 * Sampling rather than clipping on purpose: clipping a polyline against several overlapping
 * polygons is where topology errors live, and a wrong answer here would be reported as a safety
 * measurement. A sampled estimate is accurate to half a step and cannot throw.
 */
const measureFloodExposureMetres = (
  routeGeometry: LineString,
  zones: ReadonlyArray<FloodZone>,
): number => {
  const coordinates = routeGeometry.coordinates
  let exposed = 0

  for (let i = 0; i < coordinates.length - 1; i++) {
    const from = coordinates[i]!
    const to = coordinates[i + 1]!
    const segmentMetres = metresBetween(
      { longitude: from[0]!, latitude: from[1]! },
      { longitude: to[0]!, latitude: to[1]! },
    )
    if (segmentMetres === 0) continue

    const steps = Math.max(1, Math.ceil(segmentMetres / EXPOSURE_SAMPLE_METRES))
    const stepMetres = segmentMetres / steps

    for (let step = 0; step < steps; step++) {
      // Midpoint of the step, so a sample never lands exactly on a polygon edge.
      const t = (step + 0.5) / steps
      const sample = point([
        from[0]! + (to[0]! - from[0]!) * t,
        from[1]! + (to[1]! - from[1]!) * t,
      ])

      for (const zone of zones) {
        const feat: Feature<Polygon | MultiPolygon> = {
          type: 'Feature',
          properties: {},
          geometry: zone.geometry,
        }
        if (booleanPointInPolygon(sample, feat)) {
          exposed += stepMetres
          break
        }
      }
    }
  }

  return Math.round(exposed)
}

/**
 * Assesses route geometry against flood zones to count crossings, find the first crossing distance
 * and measure how far the path runs through water (R3.6).
 */
export const assessRouteCrossings = (
  routeGeometry: LineString,
  zones: ReadonlyArray<FloodZone>,
  hasFloodCoverage = true,
): CrossingReport => {
  if (!hasFloodCoverage) {
    return { count: 0, firstAtMetres: null, assessed: false, exposedMetres: 0 }
  }

  if (zones.length === 0 || routeGeometry.coordinates.length < 2) {
    return { count: 0, firstAtMetres: null, assessed: true, exposedMetres: 0 }
  }

  const routeFeature = lineString(routeGeometry.coordinates)
  const startCoord = routeGeometry.coordinates[0]
  if (!startCoord) {
    return { count: 0, firstAtMetres: null, assessed: true, exposedMetres: 0 }
  }
  const startPt = point(startCoord)
  const exposedMetres = measureFloodExposureMetres(routeGeometry, zones)

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
      exposedMetres,
    }
  }

  if (intersections.length === 0) {
    return {
      count: 0,
      firstAtMetres: null,
      assessed: true,
      exposedMetres,
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
    exposedMetres,
  }
}
