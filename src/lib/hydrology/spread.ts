/**
 * Distributes water over a DEM and reports the resulting ponded depth per cell.
 *
 * The method is a volume-constrained fill-and-spill, built from two published
 * pieces:
 *
 *  1. Priority-Flood (Barnes, Lehman & Mulla 2014) gives, in one O(n log n)
 *     sweep from the domain boundary inward, each cell's spill-level surface, a
 *     drainage forest toward the boundary, and the footprint of every closed
 *     depression. It lives in `flow.ts`, shared with the routing model.
 *  2. Level-pool fill-spill routing in the spirit of the Rapid Flood Spreading
 *     Method (Lhomme et al. 2008) and Fill-Spill-Merge (Barnes, Callaghan &
 *     Wickert 2020): each depression receives the water generated over its own
 *     drainage area, stores it up to its capacity with a flat water surface,
 *     and passes any excess to the next depression downstream — or out of the
 *     domain.
 *
 * Two optional inputs extend it from a purely pluvial model to one that can
 * carry fluvial processes. `inflowM3` injects volume at named cells — a river
 * entering the domain, or a levee breach discharging onto the floodplain.
 * `conveyanceM3` lets a depression pass water through instead of storing it,
 * which is what a river does to the valley it runs along: the valley floods
 * only once inflow exceeds what the channel can carry away.
 *
 * This is a screening model. It conserves volume exactly (stored + outflow =
 * introduced, asserted in tests) but has no notion of time, momentum, or
 * backwater: it answers "where would this much water sit once it has stopped
 * moving", not "when does it arrive".
 */
import { labelDepressions, priorityFlood, type FilledSurface } from './flow'

export interface SpreadInput {
  /** Ground elevation, metres, row-major. */
  readonly elevations: Float32Array
  readonly width: number
  readonly height: number
  /** Effective runoff depth generated on every cell, metres of water. */
  readonly runoffMetres: number
  /** Ground area of a cell in each row, m² (length = height). */
  readonly rowCellAreaM2: Float64Array
  /**
   * Cells at or below this elevation that connect to the domain edge through
   * equally low cells are treated as open water: outlets, not depressions.
   * Undefined disables the mask.
   */
  readonly oceanLevelMetres?: number
  /**
   * Extra volume introduced at individual cells, m³ — channel inflow at a
   * domain inlet, or breach outflow onto a floodplain. Added to the uniform
   * runoff, never a replacement for it.
   */
  readonly inflowM3?: Float64Array
  /**
   * Volume a cell can pass downstream without being captured by the depression
   * it sits in, m³ — the conveyance of a channel running through it.
   *
   * A depression is limited by the conveyance at its **outlet**, not by the
   * largest channel inside it. That distinction is load-bearing: a closed basin
   * with rivers draining into it has enormous conveyance at its centre and no
   * way out at all, and crediting it with the former would drain water uphill
   * over its own rim.
   */
  readonly conveyanceM3?: Float64Array
  /**
   * A filled surface already computed for exactly these elevations and ocean
   * level. Purely an optimisation: Priority-Flood is the most expensive step
   * here, and a caller that has already run it — to condition the DEM, or to
   * build a drainage network — would otherwise pay for it again. Passing a
   * surface that does not match the elevations gives wrong answers silently,
   * so it is the caller's job to be sure.
   */
  readonly surface?: FilledSurface
}

export interface SpreadResult {
  /** Ponded water depth per cell, metres, row-major. Zero where dry. */
  readonly depths: Float32Array
  /** All water introduced: uniform runoff plus every `inflowM3` injection. */
  readonly totalRunoffM3: number
  readonly storedM3: number
  /** Water that left the domain across its boundary. */
  readonly outflowM3: number
  /** Water carried through depressions by channel conveyance rather than stored. */
  readonly conveyedM3: number
  readonly depressionCount: number
  /** Depressions filled to their spill level, i.e. overflowing. */
  readonly overflowingCount: number
  /** Cells treated as open water and excluded from ponding. */
  readonly oceanCellCount: number
  /** Depression id per cell, -1 outside any depression. */
  readonly labels: Int32Array
  /** Final state of each depression, for callers that need to size its outlet. */
  readonly depressions: ReadonlyArray<DepressionState>
}

export interface DepressionState {
  readonly cellCount: number
  readonly spillMetres: number
  /** Water surface actually reached; equals spillMetres when the depression is full. */
  readonly waterLevelMetres: number
  readonly storedM3: number
  /** Ponded surface area at that level, m². */
  readonly floodedAreaM2: number
  readonly conveyedM3: number
  readonly overflowM3: number
}

/** nextDep sentinel: water reaching this cell drains off the domain edge. */
const EXITS_DOMAIN = -1

export const spreadRunoff = (input: SpreadInput): SpreadResult => {
  const {
    elevations, width, height, runoffMetres, rowCellAreaM2,
    oceanLevelMetres, inflowM3, conveyanceM3, surface: providedSurface,
  } = input
  const n = width * height
  if (elevations.length !== n) {
    throw new RangeError(`elevations holds ${elevations.length} cells, grid needs ${n}`)
  }
  if (rowCellAreaM2.length !== height) {
    throw new RangeError(`rowCellAreaM2 holds ${rowCellAreaM2.length} rows, grid needs ${height}`)
  }
  if (!Number.isFinite(runoffMetres) || runoffMetres < 0) {
    throw new RangeError(`runoffMetres must be non-negative, got ${runoffMetres}`)
  }
  if (inflowM3 !== undefined && inflowM3.length !== n) {
    throw new RangeError(`inflowM3 holds ${inflowM3.length} cells, grid needs ${n}`)
  }
  if (conveyanceM3 !== undefined && conveyanceM3.length !== n) {
    throw new RangeError(`conveyanceM3 holds ${conveyanceM3.length} cells, grid needs ${n}`)
  }

  if (providedSurface !== undefined && providedSurface.filled.length !== n) {
    throw new RangeError(
      `surface holds ${providedSurface.filled.length} cells, grid needs ${n}`,
    )
  }

  // ---- Phase 1: fill, and the drainage forest that comes with it ------------
  const surface = providedSurface ?? priorityFlood(elevations, width, height, oceanLevelMetres)
  const { parent, popOrder, oceanCellCount } = surface
  const popCount = popOrder.length

  // ---- Phase 2: label depressions ------------------------------------------
  const { label, spill: spillArray, count: compCount } = labelDepressions(
    surface, elevations, width, height,
  )
  const spillByComp = Array.from(spillArray)

  // ---- Phase 3: route water along the drainage forest ----------------------
  // nextDep[c]: the first depression a drop landing on c reaches on its way to
  // the boundary (possibly c's own), or EXITS_DOMAIN. Parents pop before
  // children, so a single pass in pop order resolves every chain.
  const nextDep = new Int32Array(n)
  for (let k = 0; k < popCount; k++) {
    const c = popOrder[k]!
    nextDep[c] = label[c]! >= 0 ? label[c]! : parent[c]! === -1 ? EXITS_DOMAIN : nextDep[parent[c]!]!
  }

  const firstPoppedIndex = new Int32Array(compCount).fill(-1)
  const firstPoppedCell = new Int32Array(compCount).fill(-1)
  for (let k = 0; k < popCount; k++) {
    const c = popOrder[k]!
    const d = label[c]!
    if (d >= 0 && firstPoppedIndex[d] === -1) {
      firstPoppedIndex[d] = k
      firstPoppedCell[d] = c
    }
  }

  // Where a full depression overflows to. The cell a depression was first
  // entered from lies just outside it and strictly downstream, so the chain
  // below that cell is the overflow path.
  const downstream = new Int32Array(compCount)
  for (let d = 0; d < compCount; d++) {
    const entryParent = parent[firstPoppedCell[d]!]!
    downstream[d] = entryParent === -1 ? EXITS_DOMAIN : nextDep[entryParent]!
  }

  const direct = new Float64Array(compCount)
  let outflowM3 = 0
  let totalRunoffM3 = 0
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / width)
    const vol = runoffMetres * rowCellAreaM2[row]! + (inflowM3 ? inflowM3[i]! : 0)
    totalRunoffM3 += vol
    const d = nextDep[i]!
    if (d >= 0) direct[d]! += vol
    else outflowM3 += vol
  }

  // ---- Phase 4: fill depressions upstream-first, convey and spill the rest --
  // A depression's downstream target was popped before it, so processing in
  // descending first-pop order guarantees every upstream contribution has
  // arrived before a depression's own water balance is settled.
  const order = Array.from({ length: compCount }, (_, d) => d).sort(
    (a, b) => firstPoppedIndex[b]! - firstPoppedIndex[a]!,
  )

  const cellsByComp: Array<number[]> = Array.from({ length: compCount }, () => [])
  for (let i = 0; i < n; i++) {
    const d = label[i]!
    if (d >= 0) cellsByComp[d]!.push(i)
  }

  // What a valley passes downstream is set at its outlet: the cell where water
  // leaves. For a river valley that is the reach carrying the river out, with
  // its full capacity; for a closed basin it is a saddle on the rim, carrying
  // nothing, which is the correct answer.
  const conveyanceByComp = new Float64Array(compCount)
  if (conveyanceM3 !== undefined) {
    for (let d = 0; d < compCount; d++) {
      const outlet = firstPoppedCell[d]!
      conveyanceByComp[d] = outlet >= 0 ? conveyanceM3[outlet]! : 0
    }
  }

  const received = new Float64Array(compCount)
  const depths = new Float32Array(n)
  const states: Array<DepressionState> = new Array(compCount)
  let storedM3 = 0
  let conveyedM3 = 0
  let overflowingCount = 0

  for (const d of order) {
    const cells = cellsByComp[d]!
    const spill = spillByComp[d]!

    let capacityM3 = 0
    for (const c of cells) {
      capacityM3 += (spill - elevations[c]!) * rowCellAreaM2[Math.floor(c / width)]!
    }

    const availableM3 = direct[d]! + received[d]!
    // The channel takes its share first: a river running through a valley
    // carries water away whether or not the valley has room to store it.
    const throughM3 = Math.min(availableM3, conveyanceByComp[d]!)
    const remainingM3 = availableM3 - throughM3
    const toStoreM3 = Math.min(remainingM3, capacityM3)
    const overflowM3 = remainingM3 - toStoreM3
    if (overflowM3 > 0) overflowingCount++

    const passedDownM3 = throughM3 + overflowM3
    if (passedDownM3 > 0) {
      const target = downstream[d]!
      if (target >= 0) received[target]! += passedDownM3
      else outflowM3 += passedDownM3
    }
    storedM3 += toStoreM3
    conveyedM3 += throughM3
    states[d] = {
      cellCount: cells.length,
      spillMetres: spill,
      waterLevelMetres: Number.NEGATIVE_INFINITY,
      storedM3: toStoreM3,
      floodedAreaM2: 0,
      conveyedM3: throughM3,
      overflowM3,
    }
    if (toStoreM3 <= 0) continue

    // Level-pool: raise a flat surface from the pit upward until the stored
    // volume is accounted for.
    cells.sort((a, b) => elevations[a]! - elevations[b]!)
    let areaSumM2 = 0
    let usedM3 = 0
    let level = spill
    let prevElev = elevations[cells[0]!]!
    let found = false
    for (const c of cells) {
      const e = elevations[c]!
      const liftM3 = areaSumM2 * (e - prevElev)
      if (usedM3 + liftM3 >= toStoreM3) {
        level = prevElev + (areaSumM2 > 0 ? (toStoreM3 - usedM3) / areaSumM2 : 0)
        found = true
        break
      }
      usedM3 += liftM3
      areaSumM2 += rowCellAreaM2[Math.floor(c / width)]!
      prevElev = e
    }
    if (!found) {
      level = Math.min(spill, prevElev + (toStoreM3 - usedM3) / areaSumM2)
    }

    let floodedAreaM2 = 0
    for (const c of cells) {
      const depth = level - elevations[c]!
      if (depth > 0) {
        depths[c] = depth
        floodedAreaM2 += rowCellAreaM2[Math.floor(c / width)]!
      }
    }
    states[d] = { ...states[d]!, waterLevelMetres: level, floodedAreaM2 }
  }

  for (let d = 0; d < compCount; d++) {
    states[d] ??= {
      cellCount: 0, spillMetres: spillByComp[d]!, waterLevelMetres: Number.NEGATIVE_INFINITY,
      storedM3: 0, floodedAreaM2: 0, conveyedM3: 0, overflowM3: 0,
    }
  }

  return {
    depths,
    totalRunoffM3,
    storedM3,
    outflowM3,
    conveyedM3,
    depressionCount: compCount,
    overflowingCount,
    oceanCellCount,
    labels: label,
    depressions: states,
  }
}
