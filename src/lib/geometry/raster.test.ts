import { describe, expect, it } from 'vitest'
import { classifyPixel, classifyRasterTile, GSI_FLOOD_LEGEND } from './raster'
import { fukuiStationTile, mabiTile10to20m } from './testing/tile-fixture'

/**
 * The legend is a transcription of someone else's rendering, so it is worth exactly as much as the
 * evidence behind it. These tests pin it to colours read out of real GSI tiles, because the table
 * this replaced was self-consistent, fully unit-tested, and wrong about five of its six rows.
 */

/** Every fill colour observed in `01_flood_l2_shinsuishin_data`, with the band GSI assigns it. */
const OBSERVED = [
  { hex: '#F7F5A9', rgb: [247, 245, 169], band: 'low', min: 0, max: 0.5 },
  { hex: '#FFD8C0', rgb: [255, 216, 192], band: 'moderate', min: 0.5, max: 3 },
  { hex: '#FFB7B7', rgb: [255, 183, 183], band: 'high', min: 3, max: 5 },
  { hex: '#FF9191', rgb: [255, 145, 145], band: 'extreme', min: 5, max: 10 },
  { hex: '#F285C9', rgb: [242, 133, 201], band: 'extreme', min: 10, max: 20 },
  { hex: '#DC7ADC', rgb: [220, 122, 220], band: 'extreme', min: 20, max: undefined },
] as const

describe('GSI flood legend (R2.4, R8.3)', () => {
  it.each(OBSERVED)('reads $hex as $min m and deeper', ({ rgb, band, min, max }) => {
    const [r, g, b] = rgb
    const result = classifyPixel(r, g, b, 255)

    expect(result.hazardClass).toBe(band)
    expect(result.depth?.minMetres).toBe(min)
    expect(result.depth?.maxMetres).toBe(max)
  })

  it('holds no colour that GSI does not paint', () => {
    const observed = new Set(OBSERVED.map((o) => o.rgb.join(',')))
    for (const entry of GSI_FLOOD_LEGEND) {
      expect(observed.has([entry.r, entry.g, entry.b].join(','))).toBe(true)
    }
    expect(GSI_FLOOD_LEGEND).toHaveLength(OBSERVED.length)
  })

  it('keeps every band far enough apart that tolerance cannot cross one', () => {
    let closest = Number.POSITIVE_INFINITY
    for (let i = 0; i < GSI_FLOOD_LEGEND.length; i++) {
      for (let j = i + 1; j < GSI_FLOOD_LEGEND.length; j++) {
        const a = GSI_FLOOD_LEGEND[i]!
        const b = GSI_FLOOD_LEGEND[j]!
        closest = Math.min(closest, Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b))
      }
    }
    // A pixel 12 units off a legend colour is still read as that band; half the closest gap is the
    // most that can ever be safe, and the old tolerance of 45 was well past it.
    expect(closest / 2).toBeGreaterThan(12)
  })

  it('reads a transparent pixel as no inundation rather than as shallow water', () => {
    expect(classifyPixel(0, 0, 0, 0).hazardClass).toBeNull()
  })

  it('refuses to guess at a colour outside the legend', () => {
    expect(classifyPixel(0, 0, 255, 255).hazardClass).toBe('unclassified')
    // #F8E1A6 and #FFFFB3 are painted in a few GSI tiles but appear in no published legend, so
    // they are reported as unreadable rather than bucketed into a neighbouring depth.
    expect(classifyPixel(248, 225, 166, 255).hazardClass).toBe('unclassified')
    expect(classifyPixel(255, 255, 179, 255).hazardClass).toBe('unclassified')
  })
})

describe('classifying a real tile', () => {
  it('finds four depth bands and no unreadable pixels around Fukui Station', () => {
    const tile = fukuiStationTile()
    const { classPixelCounts } = classifyRasterTile(tile.data, tile.width, tile.height)

    expect(classPixelCounts.low).toBeGreaterThan(0)
    expect(classPixelCounts.moderate).toBeGreaterThan(0)
    expect(classPixelCounts.high).toBeGreaterThan(0)
    expect(classPixelCounts.extreme).toBeGreaterThan(0)
    expect(classPixelCounts.unclassified).toBe(0)
  })

  it('keeps 10–20 m water out of the 3–5 m band', () => {
    const tile = mabiTile10to20m()
    const { grid, depthGrid } = classifyRasterTile(tile.data, tile.width, tile.height)

    const deepest = depthGrid.reduce((max, d) => Math.max(max, d?.minMetres ?? 0), 0)
    expect(deepest).toBe(10)
    expect(grid).toContain('extreme')
  })
})
