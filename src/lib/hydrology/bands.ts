/**
 * Turns the spread model's continuous depth grid into the depth-band /
 * hazard-class vocabulary the rest of the hazard pipeline speaks, sliced back
 * into slippy tiles so `rasterTilesToFloodZones` can vectorise it with the
 * exact per-tile georeferencing it already uses.
 */
import type { LonLat } from '../../domain/geo'
import type { DepthBand, HazardClass } from '../../domain/hazard'
import { TILE_SIZE, columnLongitude, type ElevationMosaic, type MosaicGeometry } from './terrain'

/**
 * Shallower than this is numerical residue on near-flat ground, not standing
 * water anyone should be warned about.
 */
export const MIN_REPORTED_DEPTH_METRES = 0.05

export interface InundationBand {
  readonly hazardClass: HazardClass
  readonly depth: DepthBand
}

/**
 * Band edges follow the GSI flood-depth legend (below floor level / first
 * floor / second floor / deeper), so estimated and authoritative zones read on
 * the same scale in the UI.
 */
export const INUNDATION_BANDS: ReadonlyArray<InundationBand> = [
  { hazardClass: 'low', depth: { minMetres: MIN_REPORTED_DEPTH_METRES, maxMetres: 0.5 } },
  { hazardClass: 'moderate', depth: { minMetres: 0.5, maxMetres: 3.0 } },
  { hazardClass: 'high', depth: { minMetres: 3.0, maxMetres: 5.0 } },
  { hazardClass: 'extreme', depth: { minMetres: 5.0 } },
]

export const classifyDepth = (depthMetres: number): InundationBand | null => {
  if (!(depthMetres >= MIN_REPORTED_DEPTH_METRES)) return null
  for (const band of INUNDATION_BANDS) {
    if (band.depth.maxMetres === undefined || depthMetres < band.depth.maxMetres) return band
  }
  return null
}

export interface ClassifiedTile {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly grid: Array<HazardClass | null>
  readonly depthGrid: Array<DepthBand | undefined>
  readonly width: number
  readonly height: number
}

/** Slices the mosaic-wide depth grid back into per-tile class grids. */
export const depthsToClassifiedTiles = (
  mosaic: ElevationMosaic,
  depths: Float32Array,
): ReadonlyArray<ClassifiedTile> => {
  const tilesX = mosaic.width / TILE_SIZE
  const tilesY = mosaic.height / TILE_SIZE
  const tiles: Array<ClassifiedTile> = []

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const grid: Array<HazardClass | null> = new Array(TILE_SIZE * TILE_SIZE).fill(null)
      const depthGrid: Array<DepthBand | undefined> = new Array(TILE_SIZE * TILE_SIZE)
      let any = false
      for (let row = 0; row < TILE_SIZE; row++) {
        const mosaicRowStart = (ty * TILE_SIZE + row) * mosaic.width + tx * TILE_SIZE
        for (let col = 0; col < TILE_SIZE; col++) {
          const band = classifyDepth(depths[mosaicRowStart + col]!)
          if (band === null) continue
          grid[row * TILE_SIZE + col] = band.hazardClass
          depthGrid[row * TILE_SIZE + col] = band.depth
          any = true
        }
      }
      if (any) {
        tiles.push({
          z: mosaic.zoom,
          x: mosaic.minTileX + tx,
          y: mosaic.minTileY + ty,
          grid,
          depthGrid,
          width: TILE_SIZE,
          height: TILE_SIZE,
        })
      }
    }
  }
  return tiles
}

export interface DepthSummary {
  /**
   * Deepest single cell. Fragile by construction: at 60-90 m an unresolved
   * gorge can leave a spurious closed basin whose one deepest cell reports tens
   * of metres of water. Quote `p99DepthMetres` to a reader; keep this for
   * diagnosis.
   */
  readonly maxDepthMetres: number
  /** 99th percentile over flooded cells — the robust "how deep does it get". */
  readonly p99DepthMetres: number
  /** Mean over flooded cells only — a mean over dry land would say nothing. */
  readonly meanDepthMetres: number
  readonly floodedAreaKm2: number
  readonly floodedCellCount: number
  readonly cellsConsidered: number
}

const METRES_PER_DEGREE = 111_320

/**
 * Depth statistics restricted to the query circle. The model runs on the full
 * tile rectangle because water drains across it, but the answer promised to the
 * caller is "within this radius".
 */
export const summariseDepthsInCircle = (
  mosaic: ElevationMosaic,
  geometry: MosaicGeometry,
  depths: Float32Array,
  centre: LonLat,
  radiusKm: number,
): DepthSummary => {
  const radiusM = radiusKm * 1000
  const colLon = new Float64Array(mosaic.width)
  for (let col = 0; col < mosaic.width; col++) colLon[col] = columnLongitude(mosaic, col)
  const cosCentre = Math.cos((centre.latitude * Math.PI) / 180)

  let maxDepth = 0
  let depthAreaSum = 0
  let floodedArea = 0
  let flooded = 0
  let considered = 0
  const floodedDepths: number[] = []

  for (let row = 0; row < mosaic.height; row++) {
    const dy = (geometry.rowLatitudes[row]! - centre.latitude) * METRES_PER_DEGREE
    if (Math.abs(dy) > radiusM) continue
    const area = geometry.rowCellAreaM2[row]!
    for (let col = 0; col < mosaic.width; col++) {
      const dx = (colLon[col]! - centre.longitude) * METRES_PER_DEGREE * cosCentre
      if (dx * dx + dy * dy > radiusM * radiusM) continue
      considered++
      const depth = depths[row * mosaic.width + col]!
      if (depth < MIN_REPORTED_DEPTH_METRES) continue
      flooded++
      floodedArea += area
      depthAreaSum += depth * area
      floodedDepths.push(depth)
      if (depth > maxDepth) maxDepth = depth
    }
  }

  floodedDepths.sort((a, b) => a - b)
  const p99 = floodedDepths.length
    ? floodedDepths[Math.min(floodedDepths.length - 1, Math.floor(floodedDepths.length * 0.99))]!
    : 0

  return {
    maxDepthMetres: Math.round(maxDepth * 100) / 100,
    p99DepthMetres: Math.round(p99 * 100) / 100,
    meanDepthMetres: floodedArea > 0 ? Math.round((depthAreaSum / floodedArea) * 100) / 100 : 0,
    floodedAreaKm2: Math.round((floodedArea / 1e6) * 1000) / 1000,
    floodedCellCount: flooded,
    cellsConsidered: considered,
  }
}
