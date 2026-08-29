import union from '@turf/union'
import { featureCollection, polygon } from '@turf/helpers'
import type { Feature, MultiPolygon, Polygon } from 'geojson'
import type { BBox } from '../../domain/geo'
import type { DepthBand, FloodZone, HazardClass, ZoneKind } from '../../domain/hazard'
import type { Provenance } from '../../domain/provenance'
import { tileBBox } from './tiles'

export interface VectorisedTileZone {
  readonly hazardClass: HazardClass
  readonly depth?: DepthBand
  readonly geometry: Polygon | MultiPolygon
}

/**
 * Converts pixel coords (px, py) within a tile of (width, height) to WGS84 [lon, lat].
 */
export const pixelToWgs84 = (
  px: number,
  py: number,
  width: number,
  height: number,
  [minLon, minLat, maxLon, maxLat]: BBox,
): [number, number] => {
  const lon = minLon + (px / width) * (maxLon - minLon)
  const lat = maxLat - (py / height) * (maxLat - minLat)
  return [lon, lat]
}

/**
 * Vectorises a classified 2D raster tile grid into Polygon features per hazard class (R2.4).
 * Combines consecutive horizontal pixel spans into rectangles, then unions them into clean polygons.
 */
export const vectoriseTileGrid = (
  grid: Array<HazardClass | null>,
  depthGrid: Array<DepthBand | undefined>,
  width: number,
  height: number,
  bbox: BBox,
): ReadonlyArray<VectorisedTileZone> => {
  const spansByClass = new Map<
    HazardClass,
    { depth?: DepthBand; spans: Array<{ xStart: number; xEnd: number; y: number }> }
  >()

  for (let y = 0; y < height; y++) {
    let currentClass: HazardClass | null = null
    let spanStart = 0

    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const hClass = grid[idx] ?? null

      if (hClass !== currentClass) {
        if (currentClass !== null) {
          const entry = spansByClass.get(currentClass) ?? {
            depth: depthGrid[y * width + spanStart],
            spans: [],
          }
          entry.spans.push({ xStart: spanStart, xEnd: x, y })
          spansByClass.set(currentClass, entry)
        }
        currentClass = hClass
        spanStart = x
      }
    }

    if (currentClass !== null) {
      const entry = spansByClass.get(currentClass) ?? {
        depth: depthGrid[y * width + spanStart],
        spans: [],
      }
      entry.spans.push({ xStart: spanStart, xEnd: width, y })
      spansByClass.set(currentClass, entry)
    }
  }

  const results: Array<VectorisedTileZone> = []

  for (const [hazardClass, { depth, spans }] of spansByClass.entries()) {
    if (spans.length === 0) continue

    const polyFeatures: Array<Feature<Polygon | MultiPolygon>> = spans.map(
      ({ xStart, xEnd, y }) => {
        const nw = pixelToWgs84(xStart, y, width, height, bbox)
        const ne = pixelToWgs84(xEnd, y, width, height, bbox)
        const se = pixelToWgs84(xEnd, y + 1, width, height, bbox)
        const sw = pixelToWgs84(xStart, y + 1, width, height, bbox)
        return polygon([[nw, ne, se, sw, nw]])
      },
    )

    if (polyFeatures.length === 1 && polyFeatures[0]) {
      results.push({
        hazardClass,
        depth,
        geometry: polyFeatures[0].geometry,
      })
      continue
    }

    // Merge spans into unified polygon
    let merged = polyFeatures[0]!
    for (let i = 1; i < polyFeatures.length; i++) {
      const nextFeat = polyFeatures[i]!
      try {
        const u = union(featureCollection([merged, nextFeat]))
        if (u && u.geometry) {
          merged = u as Feature<Polygon | MultiPolygon>
        }
      } catch {
        // Keep merged
      }
    }

    results.push({
      hazardClass,
      depth,
      geometry: merged.geometry,
    })
  }

  return results
}

/**
 * Full vectorisation pipeline: takes classified raster tiles and converts to FloodZone records (R2.4).
 */
export const rasterTilesToFloodZones = (
  tiles: ReadonlyArray<{
    readonly z: number
    readonly x: number
    readonly y: number
    readonly grid: Array<HazardClass | null>
    readonly depthGrid: Array<DepthBand | undefined>
    readonly width: number
    readonly height: number
  }>,
  provenance: Provenance,
  designEvent = 'L2 assumed maximum',
): ReadonlyArray<FloodZone> => {
  const zonesByClass = new Map<HazardClass, FloodZone>()

  const kind: ZoneKind = {
    kind: 'scenario',
    designEvent,
  }

  for (const tile of tiles) {
    const bbox = tileBBox(tile.x, tile.y, tile.z)
    const vectorised = vectoriseTileGrid(
      tile.grid,
      tile.depthGrid,
      tile.width,
      tile.height,
      bbox,
    )

    for (const v of vectorised) {
      const existing = zonesByClass.get(v.hazardClass)
      if (!existing) {
        zonesByClass.set(v.hazardClass, {
          id: `scenario-${v.hazardClass}`,
          kind,
          hazardClass: v.hazardClass,
          depth: v.depth,
          geometry: v.geometry,
          provenance,
        })
      } else {
        // Union with existing zone of same class
        const feat1: Feature<Polygon | MultiPolygon> = {
          type: 'Feature',
          properties: {},
          geometry: existing.geometry,
        }
        const feat2: Feature<Polygon | MultiPolygon> = {
          type: 'Feature',
          properties: {},
          geometry: v.geometry,
        }
        try {
          const u = union(featureCollection([feat1, feat2]))
          if (u && u.geometry) {
            zonesByClass.set(v.hazardClass, {
              ...existing,
              geometry: u.geometry as Polygon | MultiPolygon,
            })
          }
        } catch {
          // Keep existing
        }
      }
    }
  }

  return Array.from(zonesByClass.values())
}
