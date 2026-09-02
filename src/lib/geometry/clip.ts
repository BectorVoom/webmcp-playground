import intersect from '@turf/intersect'
import union from '@turf/union'
import { featureCollection } from '@turf/helpers'
import type { Feature, MultiPolygon, Polygon } from 'geojson'
import type { LonLat } from '../../domain/geo'
import type { FloodZone } from '../../domain/hazard'
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

  /**
   * Zones only merge with genuinely like zones.
   *
   * Keyed on the class **and** the kind **and** the source, not the class alone. With more than one
   * flood provider per region — Japan now has an assumed-maximum planning map, a real-time risk
   * grid and a global 100-year model — a class-only key unions a キキクル level-4 *forecast* into a
   * GSI *scenario* polygon and labels the result with whichever provider happened to run first.
   * That is the failure ADR-2 exists to prevent, arriving through the back door: the reader is
   * shown tonight's danger and last century's planning envelope as one shape, under one name.
   */
  const clippedByClass = new Map<string, Array<FloodZone>>()
  const mergeKey = (zone: FloodZone): string =>
    `${zone.hazardClass}|${zone.kind.kind}|${zone.provenance.sourceId}`

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
        const key = mergeKey(zone)
        const existing = clippedByClass.get(key) ?? []
        existing.push(clippedZone)
        clippedByClass.set(key, existing)
      }
    } catch {
      // In case of non-manifold or degenerate geometries, keep valid parts or skip
    }
  }

  // 2. Union overlapping zones within same hazard class
  const mergedZones: Array<FloodZone> = []

  for (const classZones of clippedByClass.values()) {
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

    // `representative` now genuinely represents the group: same class, same kind, same source.
    mergedZones.push({
      ...representative,
      geometry: currentFeature.geometry,
    })
  }

  return {
    zones: mergedZones,
    featuresIn: zones.length,
    featuresOut: mergedZones.length,
  }
}
