/**
 * Sub-grid infrastructure effects for the coupled flood model.
 *
 * The terrain grid is tens of metres wide, so a sewer pipe or a building wall
 * cannot be resolved as terrain. They still change the water balance: drains
 * remove a finite event volume, buildings displace storage, and a reservoir can
 * retain water before it is routed downstream. The functions here keep those
 * effects explicit and volume-limited rather than pretending the DEM resolves
 * them.
 */
import { TILE_SIZE, type ElevationMosaic } from './terrain'

export type InfrastructurePoint = readonly [longitude: number, latitude: number]

export interface LinearInfrastructure {
  readonly points: ReadonlyArray<InfrastructurePoint>
}

export interface BuildingFootprint {
  /** First ring is normally the outer boundary; later rings may be holes. */
  readonly rings: ReadonlyArray<ReadonlyArray<InfrastructurePoint>>
}

export interface InfrastructureGeometry {
  readonly dams: ReadonlyArray<LinearInfrastructure>
  readonly drains: ReadonlyArray<LinearInfrastructure>
  readonly buildings: ReadonlyArray<BuildingFootprint>
}

export interface RasterisedInfrastructure {
  /** One where a mapped dam structure crosses the cell. */
  readonly isDam: Uint8Array
  /** One where a mapped drain or sewer directly crosses the cell. */
  readonly isDrain: Uint8Array
  /** One where a cell lies within the requested service radius of a drain. */
  readonly isDrainServed: Uint8Array
  /** Building footprint share of each cell, from zero to one. */
  readonly buildingFraction: Float32Array
  readonly damCells: number
  readonly drainCells: number
  readonly drainServedCells: number
  readonly buildingCells: number
  readonly damsBurned: number
  readonly drainsBurned: number
  readonly buildingsBurned: number
}

/** Fractional mosaic pixel coordinates in Web Mercator. */
const toPixel = (
  mosaic: ElevationMosaic,
  [longitude, latitude]: InfrastructurePoint,
): readonly [number, number] => {
  const n = 2 ** mosaic.zoom
  const xf = ((longitude + 180) / 360) * n
  const yf = (1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2 * n
  return [(xf - mosaic.minTileX) * TILE_SIZE, (yf - mosaic.minTileY) * TILE_SIZE]
}

const cellAtPixel = (mosaic: ElevationMosaic, x: number, y: number): number => {
  const col = Math.floor(x)
  const row = Math.floor(y)
  return col < 0 || col >= mosaic.width || row < 0 || row >= mosaic.height
    ? -1
    : row * mosaic.width + col
}

/** Bresenham burn in model-pixel space; a one-point feature burns one cell. */
const burnLine = (
  feature: LinearInfrastructure,
  mosaic: ElevationMosaic,
  mask: Uint8Array,
): boolean => {
  if (feature.points.length === 0) return false
  const pixels = feature.points.map((point) => toPixel(mosaic, point))
  let burned = false

  const mark = (x: number, y: number): void => {
    const cell = cellAtPixel(mosaic, x, y)
    if (cell < 0) return
    mask[cell] = 1
    burned = true
  }

  if (pixels.length === 1) {
    const [x, y] = pixels[0]!
    mark(x, y)
    return burned
  }

  for (let i = 0; i + 1 < pixels.length; i++) {
    let [x0, y0] = pixels[i]!.map(Math.floor) as [number, number]
    const [x1, y1] = pixels[i + 1]!.map(Math.floor) as [number, number]
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let error = dx + dy
    for (let guard = 0; guard < 100_000; guard++) {
      mark(x0, y0)
      if (x0 === x1 && y0 === y1) break
      const doubled = 2 * error
      if (doubled >= dy) {
        error += dy
        x0 += sx
      }
      if (doubled <= dx) {
        error += dx
        y0 += sy
      }
    }
  }
  return burned
}

const pointInsideEvenOdd = (
  x: number,
  y: number,
  rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): boolean => {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
  }
  return inside
}

/**
 * Burns mapped infrastructure onto the DEM grid.
 *
 * Buildings use sub-cell sampling because a centre-point fill loses an entire
 * house whenever a 10 m footprint falls inside a 60 m DEM cell without
 * covering its centre. Fractions from overlapping footprints are unioned
 * conservatively by clamping at one.
 */
export const rasteriseInfrastructure = (
  geometry: InfrastructureGeometry,
  mosaic: ElevationMosaic,
  drainServiceRadiusCells: number,
  buildingSamplesPerAxis = 8,
): RasterisedInfrastructure => {
  const n = mosaic.width * mosaic.height
  const isDam = new Uint8Array(n)
  const isDrain = new Uint8Array(n)
  let damsBurned = 0
  let drainsBurned = 0

  for (const dam of geometry.dams) if (burnLine(dam, mosaic, isDam)) damsBurned++
  for (const drain of geometry.drains) if (burnLine(drain, mosaic, isDrain)) drainsBurned++

  const serviceCells = Math.max(0, Math.floor(drainServiceRadiusCells))
  const isDrainServed = Uint8Array.from(isDrain)
  if (serviceCells > 0) {
    for (let cell = 0; cell < n; cell++) {
      if (isDrain[cell] !== 1) continue
      const cx = cell % mosaic.width
      const cy = Math.floor(cell / mosaic.width)
      for (let dy = -serviceCells; dy <= serviceCells; dy++) {
        for (let dx = -serviceCells; dx <= serviceCells; dx++) {
          if (dx * dx + dy * dy > serviceCells * serviceCells) continue
          const x = cx + dx
          const y = cy + dy
          if (x >= 0 && x < mosaic.width && y >= 0 && y < mosaic.height) {
            isDrainServed[y * mosaic.width + x] = 1
          }
        }
      }
    }
  }

  const samples = Math.max(1, Math.min(16, Math.floor(buildingSamplesPerAxis)))
  const samplesPerCell = samples * samples
  const buildingFraction = new Float32Array(n)
  let buildingsBurned = 0

  for (const building of geometry.buildings) {
    const rings = building.rings
      .filter((ring) => ring.length >= 3)
      .map((ring) => ring.map((point) => toPixel(mosaic, point)))
    if (rings.length === 0) continue

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const ring of rings) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    const firstCol = Math.max(0, Math.floor(minX))
    const lastCol = Math.min(mosaic.width - 1, Math.floor(maxX))
    const firstRow = Math.max(0, Math.floor(minY))
    const lastRow = Math.min(mosaic.height - 1, Math.floor(maxY))
    let burned = false

    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = firstCol; col <= lastCol; col++) {
        let covered = 0
        for (let sy = 0; sy < samples; sy++) {
          for (let sx = 0; sx < samples; sx++) {
            const x = col + (sx + 0.5) / samples
            const y = row + (sy + 0.5) / samples
            if (pointInsideEvenOdd(x, y, rings)) covered++
          }
        }
        if (covered === 0) continue
        const cell = row * mosaic.width + col
        buildingFraction[cell] = Math.min(1, buildingFraction[cell]! + covered / samplesPerCell)
        burned = true
      }
    }
    if (burned) buildingsBurned++
  }

  let damCells = 0
  let drainCells = 0
  let drainServedCells = 0
  let buildingCells = 0
  for (let i = 0; i < n; i++) {
    if (isDam[i] === 1) damCells++
    if (isDrain[i] === 1) drainCells++
    if (isDrainServed[i] === 1) drainServedCells++
    if (buildingFraction[i]! > 0) buildingCells++
  }

  return {
    isDam,
    isDrain,
    isDrainServed,
    buildingFraction,
    damCells,
    drainCells,
    drainServedCells,
    buildingCells,
    damsBurned,
    drainsBurned,
    buildingsBurned,
  }
}

export interface StormDrainageResult {
  /** Surface runoff left in each cell after the network's finite event capacity. */
  readonly surfaceRunoffM3: Float64Array
  readonly capturedM3: number
  readonly servicedWetCells: number
}

/**
 * Removes no more runoff than falls on a served cell and no more than the
 * network's stated capacity over the event. External river inflow is kept out
 * of this function deliberately: a street inlet does not drain a river.
 */
export const applyStormDrainage = (
  runoffM3: Float64Array,
  isServed: Uint8Array,
  rowCellAreaM2: Float64Array,
  width: number,
  capacityMmPerHour: number,
  durationHours: number,
): StormDrainageResult => {
  if (runoffM3.length !== isServed.length) throw new RangeError('runoff and service grids differ')
  if (!Number.isFinite(capacityMmPerHour) || capacityMmPerHour < 0) {
    throw new RangeError(`capacityMmPerHour must be non-negative, got ${capacityMmPerHour}`)
  }
  if (!Number.isFinite(durationHours) || durationHours < 0) {
    throw new RangeError(`durationHours must be non-negative, got ${durationHours}`)
  }

  const surfaceRunoffM3 = Float64Array.from(runoffM3)
  const capacityDepthM = (capacityMmPerHour * durationHours) / 1000
  let capturedM3 = 0
  let servicedWetCells = 0
  for (let cell = 0; cell < surfaceRunoffM3.length; cell++) {
    if (isServed[cell] !== 1 || surfaceRunoffM3[cell]! <= 0) continue
    servicedWetCells++
    const cellCapacityM3 = capacityDepthM * (rowCellAreaM2[Math.floor(cell / width)] ?? 0)
    const captured = Math.min(surfaceRunoffM3[cell]!, cellCapacityM3)
    surfaceRunoffM3[cell] = surfaceRunoffM3[cell]! - captured
    capturedM3 += captured
  }
  return { surfaceRunoffM3, capturedM3, servicedWetCells }
}

export interface BuildingStorageResult {
  readonly depths: Float32Array
  readonly adjustedCells: number
  /** Largest multiplier applied to an open-area depth. */
  readonly maxDepthMultiplier: number
}

/**
 * Converts a whole-cell water depth to the depth in the part of the cell not
 * occupied by buildings. Capping the blocked share prevents a nearly full cell
 * from turning centimetres into an unbounded numerical spike.
 */
export const applyBuildingStorageDisplacement = (
  depths: Float32Array,
  buildingFraction: Float32Array,
  maximumBlockedFraction = 0.8,
): BuildingStorageResult => {
  if (depths.length !== buildingFraction.length) throw new RangeError('depth and building grids differ')
  if (!(maximumBlockedFraction >= 0 && maximumBlockedFraction < 1)) {
    throw new RangeError('maximumBlockedFraction must be at least zero and below one')
  }
  const adjusted = Float32Array.from(depths)
  let adjustedCells = 0
  let maxDepthMultiplier = 1
  for (let cell = 0; cell < adjusted.length; cell++) {
    if (adjusted[cell]! <= 0 || buildingFraction[cell]! <= 0) continue
    const blocked = Math.min(maximumBlockedFraction, buildingFraction[cell]!)
    const multiplier = 1 / (1 - blocked)
    adjusted[cell] = adjusted[cell]! * multiplier
    adjustedCells++
    maxDepthMultiplier = Math.max(maxDepthMultiplier, multiplier)
  }
  return { depths: adjusted, adjustedCells, maxDepthMultiplier }
}

export interface DamAttenuationSite {
  readonly cell: number
  /** Dam components snapped to this drainage cell. */
  readonly structures: number
  readonly reservoirAreaM2: number
  readonly storageCapacityM3: number
  readonly inflowM3: number
  readonly retainedM3: number
  readonly outflowM3: number
}

export interface DamAttenuationResult {
  /** Routed event volume after finite storage is retained at each dam. */
  readonly routedVolumeM3: Float64Array
  readonly sites: ReadonlyArray<DamAttenuationSite>
  readonly retainedM3: number
}

const damComponents = (isDam: Uint8Array, width: number, height: number): Array<number[]> => {
  const seen = new Uint8Array(isDam.length)
  const components: Array<number[]> = []
  const stack: number[] = []
  for (let start = 0; start < isDam.length; start++) {
    if (isDam[start] !== 1 || seen[start] === 1) continue
    const cells: number[] = []
    seen[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const cell = stack.pop()!
      cells.push(cell)
      const x = cell % width
      const y = Math.floor(cell / width)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const neighbour = ny * width + nx
          if (isDam[neighbour] === 1 && seen[neighbour] === 0) {
            seen[neighbour] = 1
            stack.push(neighbour)
          }
        }
      }
    }
    components.push(cells)
  }
  return components
}

/**
 * Routes event volume downstream while retaining finite storage at mapped dams.
 * Reservoir area is the mapped permanent-water area whose D8 path first meets
 * that dam; available storage is that area times the stated drawdown depth.
 */
export const routeThroughDams = (input: {
  readonly localVolumeM3: Float64Array
  readonly receivers: Int32Array
  /** Priority-Flood order: downstream cells before upstream cells. */
  readonly popOrder: Int32Array
  readonly drainageAreaM2: Float64Array
  readonly isDam: Uint8Array
  readonly isWater: Uint8Array
  readonly rowCellAreaM2: Float64Array
  readonly width: number
  readonly height: number
  readonly availableStorageDepthM: number
  readonly snapRadiusCells?: number
}): DamAttenuationResult => {
  const {
    localVolumeM3,
    receivers,
    popOrder,
    drainageAreaM2,
    isDam,
    isWater,
    rowCellAreaM2,
    width,
    height,
    availableStorageDepthM,
    snapRadiusCells = 4,
  } = input
  const n = width * height
  for (const [name, values] of Object.entries({
    localVolumeM3,
    receivers,
    drainageAreaM2,
    isDam,
    isWater,
  })) {
    if (values.length !== n) throw new RangeError(`${name} holds ${values.length} cells, grid needs ${n}`)
  }
  if (rowCellAreaM2.length !== height) throw new RangeError('rowCellAreaM2 does not match height')
  if (!Number.isFinite(availableStorageDepthM) || availableStorageDepthM < 0) {
    throw new RangeError('availableStorageDepthM must be non-negative')
  }

  const components = damComponents(isDam, width, height)
  if (components.length === 0) {
    return {
      routedVolumeM3: routeWithoutDams(localVolumeM3, receivers, popOrder),
      sites: [],
      retainedM3: 0,
    }
  }

  // One mapped line can span several cells. Snap each connected component to
  // the largest drainage line nearby, then merge components that found the same
  // outlet cell.
  const structuresByCell = new Map<number, number>()
  const radius = Math.max(0, Math.floor(snapRadiusCells))
  for (const component of components) {
    let target = component[0]!
    let bestArea = drainageAreaM2[target]!
    for (const damCell of component) {
      const cx = damCell % width
      const cy = Math.floor(damCell / width)
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || x >= width || y < 0 || y >= height) continue
          const cell = y * width + x
          if (drainageAreaM2[cell]! > bestArea) {
            bestArea = drainageAreaM2[cell]!
            target = cell
          }
        }
      }
    }
    structuresByCell.set(target, (structuresByCell.get(target) ?? 0) + 1)
  }

  const targets = [...structuresByCell.keys()]
  const damIdAt = new Int32Array(n).fill(-1)
  for (let id = 0; id < targets.length; id++) damIdAt[targets[id]!] = id

  // A cell's receiver appears before it in popOrder, so the first downstream
  // dam is already known in one forward pass.
  const downstreamDam = new Int32Array(n).fill(-1)
  for (let k = 0; k < popOrder.length; k++) {
    const cell = popOrder[k]!
    const ownDam = damIdAt[cell]!
    if (ownDam >= 0) downstreamDam[cell] = ownDam
    else {
      const receiver = receivers[cell]!
      downstreamDam[cell] = receiver >= 0 ? downstreamDam[receiver]! : -1
    }
  }

  const reservoirAreaM2 = new Float64Array(targets.length)
  for (let cell = 0; cell < n; cell++) {
    if (isWater[cell] !== 1) continue
    const id = downstreamDam[cell]!
    if (id >= 0) reservoirAreaM2[id]! += rowCellAreaM2[Math.floor(cell / width)]!
  }
  const capacityM3 = Float64Array.from(
    reservoirAreaM2,
    (area) => area * availableStorageDepthM,
  )

  const routed = Float64Array.from(localVolumeM3)
  const inflowM3 = new Float64Array(targets.length)
  const retainedAt = new Float64Array(targets.length)
  for (let k = popOrder.length - 1; k >= 0; k--) {
    const cell = popOrder[k]!
    const id = damIdAt[cell]!
    if (id >= 0) {
      inflowM3[id] = routed[cell]!
      const retained = Math.min(routed[cell]!, capacityM3[id]!)
      routed[cell] = routed[cell]! - retained
      retainedAt[id] = retained
    }
    const receiver = receivers[cell]!
    if (receiver >= 0) routed[receiver]! += routed[cell]!
  }

  const sites = targets.map((cell, id): DamAttenuationSite => ({
    cell,
    structures: structuresByCell.get(cell)!,
    reservoirAreaM2: reservoirAreaM2[id]!,
    storageCapacityM3: capacityM3[id]!,
    inflowM3: inflowM3[id]!,
    retainedM3: retainedAt[id]!,
    outflowM3: inflowM3[id]! - retainedAt[id]!,
  }))
  return {
    routedVolumeM3: routed,
    sites,
    retainedM3: retainedAt.reduce((sum, value) => sum + value, 0),
  }
}

const routeWithoutDams = (
  localVolumeM3: Float64Array,
  receivers: Int32Array,
  popOrder: Int32Array,
): Float64Array => {
  const routed = Float64Array.from(localVolumeM3)
  for (let k = popOrder.length - 1; k >= 0; k--) {
    const cell = popOrder[k]!
    const receiver = receivers[cell]!
    if (receiver >= 0) routed[receiver]! += routed[cell]!
  }
  return routed
}
