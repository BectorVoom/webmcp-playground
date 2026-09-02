import { describe, expect, it } from 'vitest'
import {
  applyBuildingStorageDisplacement,
  applyStormDrainage,
  rasteriseInfrastructure,
  routeThroughDams,
} from './infrastructure'
import { buildMosaic, TILE_SIZE, type DecodedDemTile, type ElevationMosaic } from './terrain'

const mosaic = (): ElevationMosaic => {
  const tile: DecodedDemTile = {
    x: 1817,
    y: 806,
    width: TILE_SIZE,
    height: TILE_SIZE,
    elevations: new Float32Array(TILE_SIZE * TILE_SIZE),
  }
  return buildMosaic(
    { zoom: 11, minX: 1817, maxX: 1817, minY: 806, maxY: 806, count: 1 },
    [tile],
  )
}

const coordinateAtPixel = (
  grid: ElevationMosaic,
  x: number,
  y: number,
): readonly [number, number] => {
  const n = 2 ** grid.zoom
  const longitude = ((grid.minTileX + x / TILE_SIZE) / n) * 360 - 180
  const yf = grid.minTileY + y / TILE_SIZE
  const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yf) / n))) * 180) / Math.PI
  return [longitude, latitude]
}

describe('infrastructure rasterisation', () => {
  it('burns dams and drain service areas while preserving sub-grid building share', () => {
    const grid = mosaic()
    const building = [
      coordinateAtPixel(grid, 10, 10),
      coordinateAtPixel(grid, 11, 10),
      coordinateAtPixel(grid, 11, 11),
      coordinateAtPixel(grid, 10, 11),
      coordinateAtPixel(grid, 10, 10),
    ]
    const result = rasteriseInfrastructure(
      {
        dams: [{ points: [coordinateAtPixel(grid, 30.5, 30.5)] }],
        drains: [{ points: [coordinateAtPixel(grid, 20.5, 20.5)] }],
        buildings: [{ rings: [building] }],
      },
      grid,
      1,
    )

    expect(result.damCells).toBe(1)
    expect(result.drainCells).toBe(1)
    expect(result.drainServedCells).toBe(5)
    expect(result.buildingCells).toBe(1)
    expect(result.buildingFraction[10 * grid.width + 10]).toBeCloseTo(1)
    expect(result.damsBurned).toBe(1)
    expect(result.drainsBurned).toBe(1)
    expect(result.buildingsBurned).toBe(1)
  })

  it('does not fill a building hole', () => {
    const grid = mosaic()
    const outer = [
      coordinateAtPixel(grid, 40, 40),
      coordinateAtPixel(grid, 43, 40),
      coordinateAtPixel(grid, 43, 43),
      coordinateAtPixel(grid, 40, 43),
    ]
    const hole = [
      coordinateAtPixel(grid, 41, 41),
      coordinateAtPixel(grid, 42, 41),
      coordinateAtPixel(grid, 42, 42),
      coordinateAtPixel(grid, 41, 42),
    ]
    const result = rasteriseInfrastructure(
      { dams: [], drains: [], buildings: [{ rings: [outer, hole] }] },
      grid,
      0,
    )
    expect(result.buildingFraction[41 * grid.width + 41]).toBe(0)
    expect(result.buildingFraction[40 * grid.width + 40]).toBeCloseTo(1)
  })
})

describe('storm drainage', () => {
  it('is limited by both network capacity and the runoff available in a served cell', () => {
    const runoff = Float64Array.from([5, 20, 20])
    const served = Uint8Array.from([1, 1, 0])
    // 10 mm/h for one hour over a 1000 m² cell gives 10 m³ capacity.
    const result = applyStormDrainage(runoff, served, Float64Array.from([1000]), 3, 10, 1)
    expect([...result.surfaceRunoffM3]).toEqual([0, 10, 20])
    expect(result.capturedM3).toBe(15)
    expect(result.servicedWetCells).toBe(2)
  })
})

describe('building storage displacement', () => {
  it('raises open-area depth while capping nearly solid cells', () => {
    const result = applyBuildingStorageDisplacement(
      Float32Array.from([1, 1, 0]),
      Float32Array.from([0.5, 0.95, 0.5]),
      0.8,
    )
    expect(result.depths[0]).toBeCloseTo(2)
    expect(result.depths[1]).toBeCloseTo(5)
    expect(result.depths[2]).toBe(0)
    expect(result.adjustedCells).toBe(2)
    expect(result.maxDepthMultiplier).toBeCloseTo(5)
  })
})

describe('dam attenuation', () => {
  it('retains finite mapped-reservoir storage and passes the remainder downstream', () => {
    // Cell 4 is upstream and cell 0 is the outlet. A dam at cell 2 has two
    // 100 m² permanent-water cells upstream and 0.5 m of available storage.
    const result = routeThroughDams({
      localVolumeM3: Float64Array.from([0, 0, 0, 0, 200]),
      receivers: Int32Array.from([-1, 0, 1, 2, 3]),
      popOrder: Int32Array.from([0, 1, 2, 3, 4]),
      drainageAreaM2: Float64Array.from([500, 400, 300, 200, 100]),
      isDam: Uint8Array.from([0, 0, 1, 0, 0]),
      isWater: Uint8Array.from([0, 0, 0, 1, 1]),
      rowCellAreaM2: Float64Array.from([100]),
      width: 5,
      height: 1,
      availableStorageDepthM: 0.5,
      snapRadiusCells: 0,
    })

    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.reservoirAreaM2).toBe(200)
    expect(result.sites[0]!.storageCapacityM3).toBe(100)
    expect(result.sites[0]!.inflowM3).toBe(200)
    expect(result.sites[0]!.retainedM3).toBe(100)
    expect(result.sites[0]!.outflowM3).toBe(100)
    expect(result.routedVolumeM3[0]).toBe(100)
    expect(result.retainedM3).toBe(100)
  })

  it('does not invent storage when no mapped reservoir drains to a dam', () => {
    const result = routeThroughDams({
      localVolumeM3: Float64Array.from([0, 50]),
      receivers: Int32Array.from([-1, 0]),
      popOrder: Int32Array.from([0, 1]),
      drainageAreaM2: Float64Array.from([2, 1]),
      isDam: Uint8Array.from([1, 0]),
      isWater: Uint8Array.from([0, 0]),
      rowCellAreaM2: Float64Array.from([1]),
      width: 2,
      height: 1,
      availableStorageDepthM: 2,
      snapRadiusCells: 0,
    })
    expect(result.retainedM3).toBe(0)
    expect(result.routedVolumeM3[0]).toBe(50)
  })
})
