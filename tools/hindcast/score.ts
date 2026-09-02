/**
 * Scoring: a 100 m lattice over the surveyed footprint, padded by 2 km and
 * clipped to the query circle.
 *
 * The padding is what lets over-prediction be seen at all — a lattice drawn
 * only inside the observed polygons can only ever measure hit rate. The clip to
 * the circle is because the model was never asked about anything outside it.
 * Beyond the padded box the survey says nothing, so neither does the score.
 */
import type { Observed } from './observed'
import { PolygonIndex } from './geometry'
import type { ModelRun } from './model'

export const LATTICE_SPACING_M = 100
export const OBSERVED_PAD_KM = 2

const METRES_PER_DEGREE = 111_320
const CELL_AREA_KM2 = (LATTICE_SPACING_M / 1000) ** 2

export interface LatticePoint {
  readonly longitude: number
  readonly latitude: number
}

export interface Lattice {
  readonly points: ReadonlyArray<LatticePoint>
  /** 1 where the survey mapped inundation. */
  readonly observed: Uint8Array
  /**
   * The lattice is a clipped rectangle, and the profiling needs it as a
   * rectangle: distance to the nearest observed cell is a grid operation, not a
   * point-cloud one. `cellIndex` maps a grid slot to a point, -1 outside the
   * query circle.
   */
  readonly cols: number
  readonly rows: number
  readonly cellIndex: Int32Array
  /** The inverse of `cellIndex`: grid slot of each point. */
  readonly cellOf: Int32Array
}

/**
 * Built once per event and reused across configs: the lattice depends only on
 * the observed extent and the query circle, and rebuilding it per run was a
 * large share of a sweep's wall clock.
 */
export const buildLattice = (observed: Observed): Lattice => {
  const { bbox, event, centre, index } = observed
  const padLat = (OBSERVED_PAD_KM * 1000) / METRES_PER_DEGREE
  const padLon = padLat / Math.cos((centre.latitude * Math.PI) / 180)
  const stepLat = LATTICE_SPACING_M / METRES_PER_DEGREE
  const stepLon = stepLat / Math.cos((centre.latitude * Math.PI) / 180)
  const radiusM = event.radiusKm * 1000
  const cosLat = Math.cos((centre.latitude * Math.PI) / 180)

  const minLat = bbox[1] - padLat
  const minLon = bbox[0] - padLon
  const rows = Math.floor((bbox[3] + padLat - minLat) / stepLat) + 1
  const cols = Math.floor((bbox[2] + padLon - minLon) / stepLon) + 1

  const points: Array<LatticePoint> = []
  const observedFlags: Array<number> = []
  const cellIndex = new Int32Array(rows * cols).fill(-1)
  const cellOf: Array<number> = []
  for (let row = 0; row < rows; row++) {
    const lat = minLat + row * stepLat
    const dy = (lat - centre.latitude) * METRES_PER_DEGREE
    if (Math.abs(dy) > radiusM) continue
    for (let col = 0; col < cols; col++) {
      const lon = minLon + col * stepLon
      const dx = (lon - centre.longitude) * METRES_PER_DEGREE * cosLat
      if (dx * dx + dy * dy > radiusM * radiusM) continue
      cellIndex[row * cols + col] = points.length
      cellOf.push(row * cols + col)
      points.push({ longitude: lon, latitude: lat })
      observedFlags.push(index.contains(lon, lat) ? 1 : 0)
    }
  }
  return {
    points,
    observed: Uint8Array.from(observedFlags),
    cols,
    rows,
    cellIndex,
    cellOf: Int32Array.from(cellOf),
  }
}

export interface Score {
  readonly truePositive: number
  readonly falsePositive: number
  readonly falseNegative: number
  readonly trueNegative: number
  readonly iou: number
  readonly pod: number
  readonly precision: number
  /** Lattice-derived areas, which is what the metrics are actually computed on. */
  readonly observedAreaKm2: number
  readonly modelAreaKm2: number
  readonly overPredictionRatio: number
  /** Model hazard class at each lattice point, '' where dry. */
  readonly classAt: ReadonlyArray<string>
}

export const scoreRun = (lattice: Lattice, run: ModelRun): Score => {
  const modelIndex = new PolygonIndex(run.polygons, run.classes)
  const classAt: Array<string> = new Array(lattice.points.length).fill('')
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0

  lattice.points.forEach((point, i) => {
    const hit = modelIndex.tagAt(point.longitude, point.latitude)
    if (hit !== null) classAt[i] = hit
    const wet = hit !== null
    const truth = lattice.observed[i] === 1
    if (wet && truth) tp++
    else if (wet) fp++
    else if (truth) fn++
    else tn++
  })

  const union = tp + fp + fn
  return {
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    trueNegative: tn,
    iou: union > 0 ? tp / union : 0,
    pod: tp + fn > 0 ? tp / (tp + fn) : 0,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    observedAreaKm2: (tp + fn) * CELL_AREA_KM2,
    modelAreaKm2: (tp + fp) * CELL_AREA_KM2,
    overPredictionRatio: tp + fn > 0 ? (tp + fp) / (tp + fn) : NaN,
    classAt,
  }
}

/**
 * Distance from every lattice point to the nearest set cell of `mask`, in
 * metres, by two-pass chamfer. Answers whether a set of wrong cells is a halo
 * around the right answer or a different place entirely — which is the
 * difference between a model that is nearly right and one that is not.
 *
 * The lattice is a clipped rectangle and this is a grid operation, so points
 * outside the query circle simply never carry a distance.
 */
export const distanceToMask = (lattice: Lattice, mask: Uint8Array): Float32Array => {
  const { rows, cols, cellIndex } = lattice
  const INF = 1e9
  const dist = new Float32Array(rows * cols).fill(INF)
  for (let cell = 0; cell < rows * cols; cell++) {
    const point = cellIndex[cell]!
    if (point >= 0 && mask[point] === 1) dist[cell] = 0
  }
  const D1 = 1
  const D2 = Math.SQRT2
  const relax = (at: number, from: number, cost: number): void => {
    const candidate = dist[from]! + cost
    if (candidate < dist[at]!) dist[at] = candidate
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const at = row * cols + col
      if (row > 0) relax(at, at - cols, D1)
      if (col > 0) relax(at, at - 1, D1)
      if (row > 0 && col > 0) relax(at, at - cols - 1, D2)
      if (row > 0 && col < cols - 1) relax(at, at - cols + 1, D2)
    }
  }
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const at = row * cols + col
      if (row < rows - 1) relax(at, at + cols, D1)
      if (col < cols - 1) relax(at, at + 1, D1)
      if (row < rows - 1 && col < cols - 1) relax(at, at + cols + 1, D2)
      if (row < rows - 1 && col > 0) relax(at, at + cols - 1, D2)
    }
  }
  const metres = new Float32Array(lattice.points.length)
  for (let cell = 0; cell < rows * cols; cell++) {
    const point = cellIndex[cell]!
    if (point >= 0) metres[point] = dist[cell]! * LATTICE_SPACING_M
  }
  return metres
}

export const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

export const meanOf = (values: ReadonlyArray<number>): number =>
  values.reduce((sum, v) => sum + v, 0) / (values.length || 1)
