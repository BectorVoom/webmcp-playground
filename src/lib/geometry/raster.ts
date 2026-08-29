import type { DepthBand, HazardClass } from '../../domain/hazard'

export interface LegendClass {
  readonly id: string
  readonly name: string
  readonly r: number
  readonly g: number
  readonly b: number
  readonly hazardClass: HazardClass
  readonly depth: DepthBand
}

/**
 * Official GSI Japan Flood Inundation Depth Legend (L2 assumed-maximum).
 * Reference: https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html
 */
export const GSI_FLOOD_LEGEND: ReadonlyArray<LegendClass> = [
  {
    id: '0.5m未満',
    name: '0.0 - 0.5 m (Shallow inundation)',
    r: 255,
    g: 255,
    b: 179,
    hazardClass: 'low',
    depth: { minMetres: 0.0, maxMetres: 0.5 },
  },
  {
    id: '0.5m-3.0m',
    name: '0.5 - 3.0 m (1st floor flooded)',
    r: 247,
    g: 245,
    b: 169,
    hazardClass: 'moderate',
    depth: { minMetres: 0.5, maxMetres: 3.0 },
  },
  {
    id: '3.0m-5.0m',
    name: '3.0 - 5.0 m (2nd floor flooded)',
    r: 255,
    g: 153,
    b: 153,
    hazardClass: 'high',
    depth: { minMetres: 3.0, maxMetres: 5.0 },
  },
  {
    id: '5.0m-10.0m',
    name: '5.0 - 10.0 m (Submerged)',
    r: 255,
    g: 0,
    b: 0,
    hazardClass: 'extreme',
    depth: { minMetres: 5.0, maxMetres: 10.0 },
  },
  {
    id: '10.0m-20.0m',
    name: '10.0 - 20.0 m (Severe inundation)',
    r: 160,
    g: 0,
    b: 96,
    hazardClass: 'extreme',
    depth: { minMetres: 10.0, maxMetres: 20.0 },
  },
  {
    id: '20.0m以上',
    name: '20.0 m or greater (Catastrophic)',
    r: 128,
    g: 0,
    b: 128,
    hazardClass: 'extreme',
    depth: { minMetres: 20.0 },
  },
]

export interface PixelClassification {
  readonly legendClass: LegendClass | null
  readonly hazardClass: HazardClass | null
  readonly depth?: DepthBand
}

const COLOR_TOLERANCE_SQ = 45 * 45 // Euclidean RGB distance tolerance

/**
 * Classifies an RGBA pixel against the published legend (R2.4, R8.3).
 * Transparent pixels (alpha < 32) are classified as null (no inundation).
 * Non-matching colors beyond tolerance return 'unclassified'.
 */
export const classifyPixel = (
  r: number,
  g: number,
  b: number,
  a: number,
  legend = GSI_FLOOD_LEGEND,
): PixelClassification => {
  if (a < 32) {
    return { legendClass: null, hazardClass: null }
  }

  let bestMatch: LegendClass | null = null
  let bestDistSq = Number.POSITIVE_INFINITY

  for (const entry of legend) {
    const distSq = (r - entry.r) ** 2 + (g - entry.g) ** 2 + (b - entry.b) ** 2
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestMatch = entry
    }
  }

  if (bestMatch && bestDistSq <= COLOR_TOLERANCE_SQ) {
    return {
      legendClass: bestMatch,
      hazardClass: bestMatch.hazardClass,
      depth: bestMatch.depth,
    }
  }

  // Outside tolerance -> unclassified, never guess (R8.3)
  return {
    legendClass: null,
    hazardClass: 'unclassified',
  }
}

/**
 * Classifies an entire 2D pixel buffer (width x height x 4 RGBA bytes).
 * Returns a 2D grid of classified hazard classes (or null for empty pixels).
 */
export const classifyRasterTile = (
  rgbaData: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  legend = GSI_FLOOD_LEGEND,
): {
  readonly grid: Array<HazardClass | null>
  readonly depthGrid: Array<DepthBand | undefined>
  readonly classPixelCounts: Record<HazardClass, number>
} => {
  const grid: Array<HazardClass | null> = new Array(width * height)
  const depthGrid: Array<DepthBand | undefined> = new Array(width * height)
  const counts: Record<HazardClass, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    extreme: 0,
    unclassified: 0,
  }

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4
    const r = rgbaData[offset] ?? 0
    const g = rgbaData[offset + 1] ?? 0
    const b = rgbaData[offset + 2] ?? 0
    const a = rgbaData[offset + 3] ?? 0

    const classified = classifyPixel(r, g, b, a, legend)
    grid[i] = classified.hazardClass
    depthGrid[i] = classified.depth
    if (classified.hazardClass) {
      counts[classified.hazardClass]++
    }
  }

  return { grid, depthGrid, classPixelCounts: counts }
}
