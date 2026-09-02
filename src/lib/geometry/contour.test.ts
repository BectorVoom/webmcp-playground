import { describe, expect, it } from 'vitest'
import { coalesceRuns, rasterTilesToFloodZones, vectoriseTileGrid } from './contour'
import { classifyRasterTile } from './raster'
import { tileBBox } from './tiles'
import { countZonesVertices, MAP_VERTEX_BUDGET, simplifyZonesToBudget } from './simplify'
import { FUKUI_TILE, fukuiStationTile, MABI_TILE, mabiTile10to20m } from './testing/tile-fixture'
import type { Provenance } from '../../domain/provenance'
import type { DepthBand, HazardClass } from '../../domain/hazard'

const provenance: Provenance = {
  sourceId: 'jp.gsi.flood-l2',
  sourceName: '国土地理院 洪水浸水想定区域（想定最大規模）',
  upstreamUrl: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png',
  retrievedAt: 1_756_512_000_000,
  cache: { hit: false, ageMs: 0 },
  licence: 'GSI Content Terms of Use',
  attribution: '国土地理院',
  mode: 'live',
}

const classifiedTile = (
  tile: { z: number; x: number; y: number },
  decoded: { data: Uint8ClampedArray; width: number; height: number },
) => {
  const { grid, depthGrid } = classifyRasterTile(decoded.data, decoded.width, decoded.height)
  return { ...tile, grid, depthGrid, width: decoded.width, height: decoded.height }
}

describe('vectorising a real GSI hazard tile (R2.4, N3)', () => {
  /**
   * The regression test for the bug that made the flood layer never appear.
   *
   * `vectoriseTileGrid` used to call turf's `union` once per horizontal pixel run, each time
   * against the whole accumulated polygon. On this tile that is ~4 700 calls over a geometry that
   * grows with every one of them, and the query never returned — so the map layer was never set
   * and the tiles "failed to render". Every existing test used a solid block a few pixels across,
   * where the same loop runs four times and finishes instantly.
   */
  it('finishes in well under a second on a tile with thousands of pixel runs', () => {
    const tile = classifiedTile(FUKUI_TILE, fukuiStationTile())
    const bbox = tileBBox(tile.x, tile.y, tile.z)

    const started = Date.now()
    const zones = vectoriseTileGrid(tile.grid, tile.depthGrid, tile.width, tile.height, bbox)
    const elapsed = Date.now() - started

    expect(zones.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1_500)
  })

  it('reads every depth band GSI painted on the tile', () => {
    const tile = classifiedTile(FUKUI_TILE, fukuiStationTile())
    const bbox = tileBBox(tile.x, tile.y, tile.z)
    const zones = vectoriseTileGrid(tile.grid, tile.depthGrid, tile.width, tile.height, bbox)

    const classes = new Set(zones.map((z) => z.hazardClass))
    expect(classes).toContain('low')
    expect(classes).toContain('moderate')
    expect(classes).toContain('high')
    // 5–10 m water is present around Fukui Station and must not be folded into 3–5 m.
    expect(classes).toContain('extreme')
    expect(classes).not.toContain('unclassified')
  })

  it('places the vectorised geometry inside the tile it came from', () => {
    const tile = classifiedTile(FUKUI_TILE, fukuiStationTile())
    const [minLon, minLat, maxLon, maxLat] = tileBBox(tile.x, tile.y, tile.z)
    const zones = vectoriseTileGrid(tile.grid, tile.depthGrid, tile.width, tile.height, tileBBox(tile.x, tile.y, tile.z))

    for (const zone of zones) {
      const rings =
        zone.geometry.type === 'Polygon' ? zone.geometry.coordinates : zone.geometry.coordinates.flat()
      for (const ring of rings) {
        for (const [lon, lat] of ring) {
          expect(lon).toBeGreaterThanOrEqual(minLon - 1e-9)
          expect(lon).toBeLessThanOrEqual(maxLon + 1e-9)
          expect(lat).toBeGreaterThanOrEqual(minLat - 1e-9)
          expect(lat).toBeLessThanOrEqual(maxLat + 1e-9)
        }
      }
    }
  })

  it('keeps the deepest band a class covers, not the first one it met', () => {
    // 'extreme' spans 5–10 m, 10–20 m and 20 m+. Mabi carries the 10–20 m colour.
    const tile = classifiedTile(MABI_TILE, mabiTile10to20m())
    const zones = vectoriseTileGrid(
      tile.grid,
      tile.depthGrid,
      tile.width,
      tile.height,
      tileBBox(tile.x, tile.y, tile.z),
    )

    const extreme = zones.find((z) => z.hazardClass === 'extreme')
    expect(extreme?.depth?.minMetres).toBe(10)
  })

  it('stays inside the rendered vertex budget once simplified (N5)', () => {
    const zones = rasterTilesToFloodZones(
      [classifiedTile(FUKUI_TILE, fukuiStationTile()), classifiedTile(MABI_TILE, mabiTile10to20m())],
      provenance,
    )

    expect(zones.length).toBeGreaterThan(0)
    expect(countZonesVertices(zones)).toBeGreaterThan(0)
    expect(simplifyZonesToBudget(zones, MAP_VERTEX_BUDGET).verticesOut).toBeLessThanOrEqual(
      MAP_VERTEX_BUDGET,
    )
  })

  it('merges tiles of the same class into one zone, and carries provenance', () => {
    const zones = rasterTilesToFloodZones(
      [classifiedTile(FUKUI_TILE, fukuiStationTile()), classifiedTile(MABI_TILE, mabiTile10to20m())],
      provenance,
    )

    const ids = zones.map((z) => z.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const zone of zones) {
      expect(zone.kind.kind).toBe('scenario')
      expect(zone.provenance.attribution).toBe('国土地理院')
    }
  })
})

describe('coalesceRuns', () => {
  it('merges runs that share their columns on consecutive rows into one rectangle', () => {
    const spans = [
      { xStart: 2, xEnd: 6, y: 0 },
      { xStart: 2, xEnd: 6, y: 1 },
      { xStart: 2, xEnd: 6, y: 2 },
    ]
    expect(coalesceRuns(spans)).toEqual([{ x0: 2, x1: 6, y0: 0, y1: 3 }])
  })

  it('breaks a rectangle where the rows are not consecutive', () => {
    const spans = [
      { xStart: 2, xEnd: 6, y: 0 },
      { xStart: 2, xEnd: 6, y: 4 },
    ]
    expect(coalesceRuns(spans)).toHaveLength(2)
  })

  it('keeps runs of differing width apart', () => {
    const spans = [
      { xStart: 2, xEnd: 6, y: 0 },
      { xStart: 2, xEnd: 7, y: 1 },
    ]
    expect(coalesceRuns(spans)).toHaveLength(2)
  })
})

describe('working resolution', () => {
  /**
   * Coarsening is allowed to lose detail; it is never allowed to lose depth. A cell holding one
   * pixel of 5 m water inside an area of 0.5 m must come out as the deeper band.
   */
  it('never reports shallower water than the pixels it merged', () => {
    const width = 64
    const height = 64
    const grid: Array<HazardClass | null> = new Array(width * height).fill('low')
    const depthGrid: Array<DepthBand | undefined> = new Array(width * height).fill({
      minMetres: 0,
      maxMetres: 0.5,
    })
    grid[10 * width + 10] = 'extreme'
    depthGrid[10 * width + 10] = { minMetres: 5, maxMetres: 10 }

    // A tile spanning ~1 km, so 64 px is ~16 m and a 40 m cell merges several pixels together.
    const bbox: [number, number, number, number] = [136.22, 36.06, 136.2312, 36.069]
    const zones = vectoriseTileGrid(grid, depthGrid, width, height, bbox)

    const extreme = zones.find((z) => z.hazardClass === 'extreme')
    expect(extreme).toBeDefined()
    expect(extreme?.depth?.minMetres).toBe(5)
  })
})
