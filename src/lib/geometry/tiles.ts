import type { BBox, LonLat } from '../../domain/geo'
import { createCircleBBox } from './circle'

export interface TileCoordinate {
  readonly z: number
  readonly x: number
  readonly y: number
}

export interface TileCoverResult {
  readonly tiles: ReadonlyArray<TileCoordinate>
  readonly totalNeeded: number
  readonly capApplied: boolean
  readonly fractionCovered: number
}

export const lon2tile = (lon: number, zoom: number): number => {
  const n = 2 ** zoom
  return Math.floor(((lon + 180) / 360) * n)
}

export const lat2tile = (lat: number, zoom: number): number => {
  const n = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  const clampedLatRad = Math.max(-85.05112878 * Math.PI / 180, Math.min(85.05112878 * Math.PI / 180, latRad))
  return Math.floor(
    ((1 - Math.log(Math.tan(clampedLatRad) + 1 / Math.cos(clampedLatRad)) / Math.PI) / 2) * n,
  )
}

export const tile2lon = (x: number, zoom: number): number => {
  const n = 2 ** zoom
  return (x / n) * 360 - 180
}

export const tile2lat = (y: number, zoom: number): number => {
  const n = 2 ** zoom
  const sinh = Math.sinh(Math.PI * (1 - (2 * y) / n))
  return (Math.atan(sinh) * 180) / Math.PI
}

export const tileBBox = (x: number, y: number, zoom: number): BBox => {
  const minLon = tile2lon(x, zoom)
  const maxLon = tile2lon(x + 1, zoom)
  const maxLat = tile2lat(y, zoom)
  const minLat = tile2lat(y + 1, zoom)
  return [minLon, minLat, maxLon, maxLat]
}

/**
 * Computes the slippy-tile grid covering a query circle at zoom z, with cap applied (R2.5).
 */
export const getCoveringTiles = (
  center: LonLat,
  radiusKm: number,
  zoom = 15,
  cap = 64,
): TileCoverResult => {
  const [minLon, minLat, maxLon, maxLat] = createCircleBBox(center, radiusKm)

  const minX = lon2tile(minLon, zoom)
  const maxX = lon2tile(maxLon, zoom)
  const minY = lat2tile(maxLat, zoom) // Y increases southward in Slippy tiles
  const maxY = lat2tile(minLat, zoom)

  const centerX = lon2tile(center.longitude, zoom)
  const centerY = lat2tile(center.latitude, zoom)

  const allTiles: Array<TileCoordinate & { distSq: number }> = []

  for (let x = Math.min(minX, maxX); x <= Math.max(minX, maxX); x++) {
    for (let y = Math.min(minY, maxY); y <= Math.max(minY, maxY); y++) {
      const distSq = (x - centerX) ** 2 + (y - centerY) ** 2
      allTiles.push({ z: zoom, x, y, distSq })
    }
  }

  const totalNeeded = allTiles.length

  // Sort by distance from centre tile outward so the most critical tiles are kept first if capped
  allTiles.sort((a, b) => a.distSq - b.distSq)

  const cappedTiles = allTiles.slice(0, cap).map(({ z, x, y }) => ({ z, x, y }))
  const capApplied = totalNeeded > cap
  const fractionCovered = totalNeeded > 0 ? Math.min(1, cappedTiles.length / totalNeeded) : 1

  return {
    tiles: cappedTiles,
    totalNeeded,
    capApplied,
    fractionCovered: Math.round(fractionCovered * 100) / 100,
  }
}
