import type { Polygon, MultiPolygon } from 'geojson'
import type { BBox, ResolvedLocation } from './geo'
import type { Coverage, Provenance, Staleness } from './provenance'

export type ZoneKind =
  | { readonly kind: 'forecast'; readonly validFrom: number; readonly validTo: number }
  | { readonly kind: 'scenario'; readonly designEvent: string }

export type HazardClass = 'extreme' | 'high' | 'moderate' | 'low' | 'unclassified'

export interface DepthBand {
  readonly minMetres: number
  readonly maxMetres?: number
}

export interface FloodZone {
  readonly id: string
  readonly kind: ZoneKind
  readonly hazardClass: HazardClass
  readonly depth?: DepthBand
  readonly geometry: Polygon | MultiPolygon
  readonly provenance: Provenance
}

export interface NearestZoneEdge {
  readonly metres: number
  readonly bearing: number
  readonly direction: string
  readonly hazardClass: HazardClass
}

export interface HazardSnapshot {
  readonly location: ResolvedLocation
  readonly radiusKm: number
  readonly zones: ReadonlyArray<FloodZone>
  readonly userInZone: FloodZone | null
  readonly nearest: NearestZoneEdge | null
  readonly coverage: Coverage
  readonly staleness: Staleness
  readonly geometryStats: {
    readonly featuresIn: number
    readonly verticesIn: number
    readonly verticesOut: number
  }
}

export const getZoneBBox = (zone: FloodZone): BBox | null => {
  const coords: Array<[number, number]> = []
  if (zone.geometry.type === 'Polygon') {
    for (const ring of zone.geometry.coordinates) {
      for (const pt of ring) {
        if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
          coords.push([pt[0], pt[1]])
        }
      }
    }
  } else if (zone.geometry.type === 'MultiPolygon') {
    for (const poly of zone.geometry.coordinates) {
      for (const ring of poly) {
        for (const pt of ring) {
          if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
            coords.push([pt[0], pt[1]])
          }
        }
      }
    }
  }

  if (coords.length === 0) return null

  const first = coords[0]!
  let minLon = first[0]
  let minLat = first[1]
  let maxLon = first[0]
  let maxLat = first[1]

  for (const pt of coords) {
    const lon = pt[0]
    const lat = pt[1]
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }

  return [minLon, minLat, maxLon, maxLat]
}
