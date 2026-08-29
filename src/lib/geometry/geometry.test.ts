import { describe, expect, it } from 'vitest'
import { createCircleBBox, createCirclePolygon } from './circle'
import { clipAndMergeZones } from './clip'
import { simplifyZonesToBudget } from './simplify'
import { assessFacilityRisk, findContainingZone, findNearestZoneEdge, isPointInGeometry } from './measure'
import { assessRouteCrossings } from './crossings'
import { getCoveringTiles, lon2tile, lat2tile, tileBBox } from './tiles'
import { classifyPixel } from './raster'
import { rasterTilesToFloodZones, vectoriseTileGrid } from './contour'
import type { DepthBand, FloodZone, HazardClass } from '../../domain/hazard'
import type { Provenance } from '../../domain/provenance'

const mockProvenance: Provenance = {
  sourceId: 'jp.gsi.flood-l2',
  sourceName: 'GSI Hazard Map',
  upstreamUrl: 'https://cyberjapandata.gsi.go.jp/xyz/...',
  retrievedAt: Date.now(),
  cache: { hit: false, ageMs: 0 },
  licence: 'GSI Open Data',
  attribution: '国土地理院',
  mode: 'fixture',
}

describe('lib/geometry / circle and bbox (R1.9, R2.1)', () => {
  it('creates circle polygon with expected coordinate length', () => {
    const poly = createCirclePolygon({ latitude: 35.6812, longitude: 139.7671 }, 20, 64)
    expect(poly.type).toBe('Polygon')
    expect(poly.coordinates[0]?.length).toBe(65) // 64 steps + closing point
  })

  it('computes circle bbox containing center', () => {
    const center = { latitude: 35.6812, longitude: 139.7671 }
    const [minLon, minLat, maxLon, maxLat] = createCircleBBox(center, 20)
    expect(center.longitude).toBeGreaterThan(minLon)
    expect(center.longitude).toBeLessThan(maxLon)
    expect(center.latitude).toBeGreaterThan(minLat)
    expect(center.latitude).toBeLessThan(maxLat)
  })
})

describe('lib/geometry / clip and merge (R2.6)', () => {
  it('clips zones outside query circle and unions same-class zones', () => {
    const center = { latitude: 35.68, longitude: 139.76 }
    const zone1: FloodZone = {
      id: 'z1',
      kind: { kind: 'scenario', designEvent: 'L2' },
      hazardClass: 'high',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.75, 35.67],
            [139.77, 35.67],
            [139.77, 35.69],
            [139.75, 35.69],
            [139.75, 35.67],
          ],
        ],
      },
      provenance: mockProvenance,
    }

    const zone2: FloodZone = {
      id: 'z2',
      kind: { kind: 'scenario', designEvent: 'L2' },
      hazardClass: 'high',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.76, 35.68],
            [139.78, 35.68],
            [139.78, 35.70],
            [139.76, 35.70],
            [139.76, 35.68],
          ],
        ],
      },
      provenance: mockProvenance,
    }

    const res = clipAndMergeZones([zone1, zone2], center, 10)
    expect(res.featuresIn).toBe(2)
    expect(res.featuresOut).toBe(1) // merged into single high class zone
    expect(res.zones[0]?.hazardClass).toBe('high')
  })
})

describe('lib/geometry / simplification budget search (R2.6, N5)', () => {
  it('reduces vertex count when over budget', () => {
    // Generate high vertex polygon
    const points: Array<[number, number]> = []
    const count = 100
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI
      const r = 0.01 + 0.002 * Math.sin(i * 5)
      points.push([139.76 + r * Math.cos(angle), 35.68 + r * Math.sin(angle)])
    }
    points.push(points[0]!)

    const zone: FloodZone = {
      id: 'z-high',
      kind: { kind: 'scenario', designEvent: 'L2' },
      hazardClass: 'moderate',
      geometry: {
        type: 'Polygon',
        coordinates: [points],
      },
      provenance: mockProvenance,
    }

    const res = simplifyZonesToBudget([zone], 30)
    expect(res.verticesIn).toBe(101)
    expect(res.verticesOut).toBeLessThanOrEqual(35)
    expect(res.toleranceUsed).toBeGreaterThan(0)
  })
})

describe('lib/geometry / measurement and facility risk (R2.7, R3.2)', () => {
  const squareZone: FloodZone = {
    id: 'z-sq',
    kind: { kind: 'scenario', designEvent: 'L2' },
    hazardClass: 'extreme',
    depth: { minMetres: 5.0, maxMetres: 10.0 },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [139.70, 35.70],
          [139.80, 35.70],
          [139.80, 35.80],
          [139.70, 35.80],
          [139.70, 35.70],
        ],
      ],
    },
    provenance: mockProvenance,
  }

  it('detects point in polygon', () => {
    expect(isPointInGeometry({ latitude: 35.75, longitude: 139.75 }, squareZone.geometry)).toBe(true)
    expect(isPointInGeometry({ latitude: 35.60, longitude: 139.75 }, squareZone.geometry)).toBe(false)
  })

  it('finds containing zone for user position', () => {
    const inside = findContainingZone({ latitude: 35.75, longitude: 139.75 }, [squareZone])
    expect(inside?.id).toBe('z-sq')

    const outside = findContainingZone({ latitude: 35.60, longitude: 139.75 }, [squareZone])
    expect(outside).toBeNull()
  })

  it('finds nearest zone edge distance and bearing', () => {
    const userLoc = { latitude: 35.65, longitude: 139.75 }
    const nearest = findNearestZoneEdge(userLoc, [squareZone])
    expect(nearest).not.toBeNull()
    expect(nearest?.metres).toBeGreaterThan(5000)
    expect(nearest?.bearing).toBeGreaterThanOrEqual(0)
    expect(nearest?.bearing).toBeLessThanOrEqual(360)
  })

  it('assesses facility risk states correctly (clear, at_risk, unknown)', () => {
    // Inside zone -> at_risk
    const atRisk = assessFacilityRisk({ latitude: 35.75, longitude: 139.75 }, [squareZone], true)
    expect(atRisk.risk).toBe('at_risk')
    expect(atRisk.matchingZone?.id).toBe('z-sq')

    // Outside zone -> clear
    const clear = assessFacilityRisk({ latitude: 35.60, longitude: 139.75 }, [squareZone], true)
    expect(clear.risk).toBe('clear')

    // No coverage -> unknown
    const unknown = assessFacilityRisk({ latitude: 35.60, longitude: 139.75 }, [squareZone], false)
    expect(unknown.risk).toBe('unknown')
  })
})

describe('lib/geometry / route crossings (R3.6)', () => {
  const hazardZone: FloodZone = {
    id: 'hz-1',
    kind: { kind: 'scenario', designEvent: 'L2' },
    hazardClass: 'high',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [139.74, 35.68],
          [139.76, 35.68],
          [139.76, 35.70],
          [139.74, 35.70],
          [139.74, 35.68],
        ],
      ],
    },
    provenance: mockProvenance,
  }

  it('counts intersections and measures first crossing distance', () => {
    // Route from (139.72, 35.69) to (139.78, 35.69) cuts through zone
    const route = {
      type: 'LineString' as const,
      coordinates: [
        [139.72, 35.69],
        [139.78, 35.69],
      ],
    }

    const report = assessRouteCrossings(route, [hazardZone], true)
    expect(report.assessed).toBe(true)
    expect(report.count).toBeGreaterThanOrEqual(1)
    expect(report.firstAtMetres).toBeGreaterThan(0)
  })

  it('marks first crossing at 0m when starting inside zone', () => {
    const route = {
      type: 'LineString' as const,
      coordinates: [
        [139.75, 35.69], // starts inside zone
        [139.80, 35.69],
      ],
    }

    const report = assessRouteCrossings(route, [hazardZone], true)
    expect(report.assessed).toBe(true)
    expect(report.count).toBeGreaterThanOrEqual(1)
    expect(report.firstAtMetres).toBe(0)
  })

  it('marks assessed: false when there is no flood coverage', () => {
    const route = {
      type: 'LineString' as const,
      coordinates: [
        [139.72, 35.69],
        [139.78, 35.69],
      ],
    }
    const report = assessRouteCrossings(route, [hazardZone], false)
    expect(report.assessed).toBe(false)
    expect(report.count).toBe(0)
    expect(report.firstAtMetres).toBeNull()
  })
})

describe('lib/geometry / slippy tiles (R2.5)', () => {
  it('converts lon/lat to tile coords and back consistently', () => {
    const lon = 139.7671
    const lat = 35.6812
    const z = 15
    const x = lon2tile(lon, z)
    const y = lat2tile(lat, z)

    const bbox = tileBBox(x, y, z)
    expect(lon).toBeGreaterThanOrEqual(bbox[0])
    expect(lon).toBeLessThanOrEqual(bbox[2])
    expect(lat).toBeGreaterThanOrEqual(bbox[1])
    expect(lat).toBeLessThanOrEqual(bbox[3])
  })

  it('caps covering tiles to specified limit and computes fraction covered (R2.5)', () => {
    const center = { latitude: 35.6812, longitude: 139.7671 }
    // 20 km radius at zoom 15 has hundreds of tiles
    const res = getCoveringTiles(center, 20, 15, 64)
    expect(res.tiles.length).toBe(64)
    expect(res.capApplied).toBe(true)
    expect(res.totalNeeded).toBeGreaterThan(64)
    expect(res.fractionCovered).toBeLessThan(1)
  })
})

describe('lib/geometry / raster classification & contouring (R2.4, R8.3, Checkpoint 3)', () => {
  it('classifies official GSI legend colors correctly', () => {
    // Red (5.0 - 10.0m)
    const red = classifyPixel(255, 0, 0, 255)
    expect(red.hazardClass).toBe('extreme')
    expect(red.depth?.minMetres).toBe(5.0)

    // Pink (3.0 - 5.0m)
    const pink = classifyPixel(255, 153, 153, 255)
    expect(pink.hazardClass).toBe('high')
    expect(pink.depth?.minMetres).toBe(3.0)

    // Transparent pixel
    const trans = classifyPixel(0, 0, 0, 0)
    expect(trans.hazardClass).toBeNull()

    // Random non-legend color (e.g. bright blue [0, 0, 255])
    const unknownColor = classifyPixel(0, 0, 255, 255)
    expect(unknownColor.hazardClass).toBe('unclassified')
  })

  it('vectorises a synthetic raster tile grid to expected polygons', () => {
    const width = 8
    const height = 8
    // Create a 4x4 block of 'high' flood hazard in the center
    const grid: Array<HazardClass | null> = new Array(width * height).fill(null)
    const depthGrid: Array<DepthBand | undefined> = new Array(width * height).fill(undefined)

    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) {
        grid[y * width + x] = 'high'
        depthGrid[y * width + x] = { minMetres: 3.0, maxMetres: 5.0 }
      }
    }

    const bbox: [number, number, number, number] = [139.7, 35.6, 139.8, 35.7]
    const zones = vectoriseTileGrid(grid, depthGrid, width, height, bbox)

    expect(zones.length).toBe(1)
    expect(zones[0]?.hazardClass).toBe('high')
    expect(zones[0]?.geometry.type).toBe('Polygon')

    // Full pipeline
    const floodZones = rasterTilesToFloodZones(
      [{ z: 15, x: 29080, y: 12900, grid, depthGrid, width, height }],
      mockProvenance,
    )
    expect(floodZones.length).toBe(1)
    expect(floodZones[0]?.kind.kind).toBe('scenario')
    expect(floodZones[0]?.hazardClass).toBe('high')
  })
})

describe('lib/geometry / performance & chunking (N3)', () => {
  it('processes 5,000 synthetic features within 250 ms budget', () => {
    const center = { latitude: 35.6812, longitude: 139.7671 }
    const zones: Array<FloodZone> = []

    for (let i = 0; i < 5000; i++) {
      const lon = 139.7 + (i % 100) * 0.001
      const lat = 35.6 + Math.floor(i / 100) * 0.001
      zones.push({
        id: `synth-${i}`,
        kind: { kind: 'scenario', designEvent: 'L2' },
        hazardClass: i % 2 === 0 ? 'low' : 'moderate',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [lon, lat],
              [lon + 0.0005, lat],
              [lon + 0.0005, lat + 0.0005],
              [lon, lat + 0.0005],
              [lon, lat],
            ],
          ],
        },
        provenance: mockProvenance,
      })
    }

    const startTime = performance.now()
    const result = findContainingZone(center, zones)
    const duration = performance.now() - startTime

    expect(result).toBeDefined()
    expect(duration).toBeLessThan(250)
  })
})
