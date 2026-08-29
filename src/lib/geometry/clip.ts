import intersect from '@turf/intersect'
import union from '@turf/union'
import { featureCollection } from '@turf/helpers'
import type { Feature, MultiPolygon, Polygon } from 'geojson'
import type { LonLat } from '../../domain/geo'
import type { FloodZone, HazardClass } from '../../domain/hazard'
import { createCircleFeature } from './circle'

export interface ClippedFloodZonesResult {
  readonly zones: ReadonlyArray<FloodZone>
  readonly featuresIn: number
  readonly featuresOut: number
}

/**
 * Clips flood zones to query circle and unions zones of the same hazard class (R2.6).
 */
export const clipAndMergeZones = (
  zones: ReadonlyArray<FloodZone>,
  center: LonLat,
  radiusKm: number,
): ClippedFloodZonesResult => {
  if (zones.length === 0) {
    return { zones: [], featuresIn: 0, featuresOut: 0 }
  }

  const circleFeature = createCircleFeature(center, radiusKm, 64)

  // 1. Clip each zone to circle
  const clippedByClass = new Map<HazardClass, Array<FloodZone>>()

  for (const zone of zones) {
    const zoneFeature: Feature<Polygon | MultiPolygon> = {
      type: 'Feature',
      properties: {},
      geometry: zone.geometry,
    }

    try {
      const intersection = intersect(featureCollection([circleFeature, zoneFeature]))
      if (intersection && intersection.geometry) {
        const clippedZone: FloodZone = {
          ...zone,
          geometry: intersection.geometry as Polygon | MultiPolygon,
        }
        const existing = clippedByClass.get(zone.hazardClass) ?? []
        existing.push(clippedZone)
        clippedByClass.set(zone.hazardClass, existing)
      }
    } catch {
      // In case of non-manifold or degenerate geometries, keep valid parts or skip
    }
  }

  // 2. Union overlapping zones within same hazard class
  const mergedZones: Array<FloodZone> = []

  for (const [hazardClass, classZones] of clippedByClass.entries()) {
    if (classZones.length === 0) continue

    if (classZones.length === 1 && classZones[0]) {
      mergedZones.push(classZones[0])
      continue
    }

    // Merge class zones iteratively
    let currentFeature: Feature<Polygon | MultiPolygon> = {
      type: 'Feature',
      properties: {},
      geometry: classZones[0]!.geometry,
    }
    const representative = classZones[0]!

    for (let i = 1; i < classZones.length; i++) {
      const nextZone = classZones[i]!
      const nextFeature: Feature<Polygon | MultiPolygon> = {
        type: 'Feature',
        properties: {},
        geometry: nextZone.geometry,
      }
      try {
        const merged = union(featureCollection([currentFeature, nextFeature]))
        if (merged && merged.geometry) {
          currentFeature = merged as Feature<Polygon | MultiPolygon>
        }
      } catch {
        // If union fails, push individual and continue
        mergedZones.push(nextZone)
      }
    }

    mergedZones.push({
      ...representative,
      hazardClass,
      geometry: currentFeature.geometry,
    })
  }

  return {
    zones: mergedZones,
    featuresIn: zones.length,
    featuresOut: mergedZones.length,
  }
}
