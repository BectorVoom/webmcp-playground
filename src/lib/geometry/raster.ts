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
 * The GSI 洪水浸水想定区域（想定最大規模）浸水深 legend, as the tiles actually paint it.
 *
 * Verified on 30 August 2026 by decoding real tiles from
 * `01_flood_l2_shinsuishin_data` at 15 locations (Fukui, Edogawa, Katsushika, Koto, Arakawa,
 * Saitama, Nishiyodogawa, Amagasaki, Nobi, Wanouchi, Kurashiki, Mabi, Hitoyoshi, Saga, Chikugo)
 * and at zooms 11–14. Every tile is painted in flat palette colours with no anti-aliasing, and
 * 100% of opaque pixels matched this table exactly at every zoom.
 *
 * The table this replaces was a transcription, and only one of its six colours (#F7F5A9) occurs in
 * a GSI tile at all — where it also carried the wrong depth band. The practical effect on real
 * data was that <0.5 m read as 0.5–3.0 m, 5–10 m read as 3–5 m, and the two deepest bands —
 * 10–20 m and 20 m+ — matched nothing and were discarded as unreadable. See
 * `docs/specs/disaster-safety/tech-debt.md`.
 */
export const GSI_FLOOD_LEGEND: ReadonlyArray<LegendClass> = [
  {
    id: '0.5m未満',
    name: '0.0 - 0.5 m (Below floor level)',
    r: 247,
    g: 245,
    b: 169, // #F7F5A9
    hazardClass: 'low',
    depth: { minMetres: 0.0, maxMetres: 0.5 },
  },
  {
    id: '0.5m以上3.0m未満',
    name: '0.5 - 3.0 m (1st floor flooded)',
    r: 255,
    g: 216,
    b: 192, // #FFD8C0
    hazardClass: 'moderate',
    depth: { minMetres: 0.5, maxMetres: 3.0 },
  },
  {
    id: '3.0m以上5.0m未満',
    name: '3.0 - 5.0 m (2nd floor flooded)',
    r: 255,
    g: 183,
    b: 183, // #FFB7B7
    hazardClass: 'high',
    depth: { minMetres: 3.0, maxMetres: 5.0 },
  },
  {
    id: '5.0m以上10.0m未満',
    name: '5.0 - 10.0 m (3rd floor and above)',
    r: 255,
    g: 145,
    b: 145, // #FF9191
    hazardClass: 'extreme',
    depth: { minMetres: 5.0, maxMetres: 10.0 },
  },
  {
    id: '10.0m以上20.0m未満',
    name: '10.0 - 20.0 m (Whole building submerged)',
    r: 242,
    g: 133,
    b: 201, // #F285C9
    hazardClass: 'extreme',
    depth: { minMetres: 10.0, maxMetres: 20.0 },
  },
  {
    // The one band not seen in the sample above; it covers a handful of dam-break and deep-valley
    // areas nationwide. Taken from the published legend rather than from an observed pixel, and
    // labelled as such so the next person knows which rows were confirmed against real data.
    id: '20.0m以上',
    name: '20.0 m or greater',
    r: 220,
    g: 122,
    b: 220, // #DC7ADC
    hazardClass: 'extreme',
    depth: { minMetres: 20.0 },
  },
]

export interface PixelClassification {
  readonly legendClass: LegendClass | null
  readonly hazardClass: HazardClass | null
  readonly depth?: DepthBand
}

/**
 * How far a pixel may sit from a legend colour and still be read as that band.
 *
 * The closest two legend colours are 31 apart in RGB (#F285C9 vs #DC7ADC), so anything above 15
 * can pull a pixel across a band boundary — and the previous value was 45. It is set well inside
 * that because GSI paints flat palette colours: every opaque pixel in the verification sample was
 * an exact match, so the tolerance only has to absorb decoder rounding, not real variation.
 */
const COLOR_TOLERANCE_SQ = 12 * 12

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

  /**
   * One classification per distinct colour, not per pixel.
   *
   * GSI paints these tiles from a flat palette: a whole 256×256 tile holds four or five colours
   * plus transparency. Scanning the legend for all 65 536 pixels therefore repeats the same six
   * distance calculations tens of thousands of times, and a 20 km query is 200-odd tiles — 14
   * million pixels, which measured at ~1.9 s and was the single largest cost in the query once the
   * tile cap was raised to cover the whole circle. Keyed on the packed RGBA word, with alpha
   * flattened to the only distinction the classifier draws.
   */
  const seen = new Map<number, PixelClassification>()

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4
    const r = rgbaData[offset] ?? 0
    const g = rgbaData[offset + 1] ?? 0
    const b = rgbaData[offset + 2] ?? 0
    const a = rgbaData[offset + 3] ?? 0

    const key = a < 32 ? -1 : ((r << 16) | (g << 8) | b)
    let classified = seen.get(key)
    if (classified === undefined) {
      classified = classifyPixel(r, g, b, a, legend)
      seen.set(key, classified)
    }

    grid[i] = classified.hazardClass
    depthGrid[i] = classified.depth
    if (classified.hazardClass) {
      counts[classified.hazardClass]++
    }
  }

  return { grid, depthGrid, classPixelCounts: counts }
}
