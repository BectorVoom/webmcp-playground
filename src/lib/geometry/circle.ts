import circle from '@turf/circle'
import bbox from '@turf/bbox'
import type { Feature, Polygon } from 'geojson'
import type { BBox, LonLat } from '../../domain/geo'

/**
 * Creates a circular polygon around a centre point (R1.9, R2.1).
 */
export const createCircleFeature = (
  center: LonLat,
  radiusKm: number,
  steps = 64,
): Feature<Polygon> => {
  return circle([center.longitude, center.latitude], radiusKm, {
    steps,
    units: 'kilometers',
  })
}

export const createCirclePolygon = (
  center: LonLat,
  radiusKm: number,
  steps = 64,
): Polygon => {
  return createCircleFeature(center, radiusKm, steps).geometry
}

/**
 * Computes bounding box [minLon, minLat, maxLon, maxLat] from any GeoJSON object.
 */
export const computeBBox = (geojson: GeoJSON.GeoJsonObject): BBox => {
  const [minLon, minLat, maxLon, maxLat] = bbox(geojson as Parameters<typeof bbox>[0])
  return [minLon, minLat, maxLon, maxLat]
}

export const createCircleBBox = (center: LonLat, radiusKm: number): BBox => {
  const circleFeature = createCircleFeature(center, radiusKm, 32)
  return computeBBox(circleFeature)
}
