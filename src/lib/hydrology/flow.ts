/**
 * Drainage-network analysis over a DEM: depression filling, D8 flow directions,
 * flow accumulation, and channel extraction.
 *
 * This is the shared foundation for both the pluvial spreading model and the
 * fluvial routing model. `priorityFlood` lives here rather than in `spread.ts`
 * because both need the same filled surface, and two copies of it would be two
 * chances to disagree about where the water goes.
 *
 * References:
 *  - Priority-Flood: Barnes, Lehman & Mulla (2014), "Priority-flood: An optimal
 *    depression-filling and watershed-labeling algorithm for digital elevation
 *    models", Computers & Geosciences 62.
 *  - D8 flow directions: O'Callaghan & Mark (1984), "The extraction of drainage
 *    networks from digital elevation data", CVGIP 28.
 *  - Channel extraction by contributing-area threshold: Tarboton, Bras &
 *    Rodriguez-Iturbe (1991), "On the extraction of channel networks from
 *    digital elevation data", Hydrological Processes 5.
 */

/** dx, dy, and the diagonal flag — distance depends on the row's ground geometry. */
export const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number, boolean]> = [
  [-1, -1, true], [0, -1, false], [1, -1, true],
  [-1, 0, false], [1, 0, false],
  [-1, 1, true], [0, 1, false], [1, 1, true],
]

/** Indexed binary min-heap on (key, insertion order) — deterministic pop order. */
class MinHeap {
  private readonly items: Int32Array
  private readonly keys: Float64Array
  private readonly seqs: Float64Array
  private size = 0
  private nextSeq = 0

  constructor(capacity: number) {
    this.items = new Int32Array(capacity)
    this.keys = new Float64Array(capacity)
    this.seqs = new Float64Array(capacity)
  }

  get length(): number {
    return this.size
  }

  push(item: number, key: number): void {
    let i = this.size++
    this.items[i] = item
    this.keys[i] = key
    this.seqs[i] = this.nextSeq++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number {
    const top = this.items[0]!
    this.size--
    if (this.size > 0) {
      this.items[0] = this.items[this.size]!
      this.keys[0] = this.keys[this.size]!
      this.seqs[0] = this.seqs[this.size]!
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < this.size && this.less(l, smallest)) smallest = l
        if (r < this.size && this.less(r, smallest)) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return top
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a]!
    const kb = this.keys[b]!
    return ka < kb || (ka === kb && this.seqs[a]! < this.seqs[b]!)
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a]!
    this.items[a] = this.items[b]!
    this.items[b] = ti
    const tk = this.keys[a]!
    this.keys[a] = this.keys[b]!
    this.keys[b] = tk
    const ts = this.seqs[a]!
    this.seqs[a] = this.seqs[b]!
    this.seqs[b] = ts
  }
}

export interface FilledSurface {
  /** Spill-level surface: ground elevation raised to the level water must reach to escape. */
  readonly filled: Float64Array
  /** The cell each cell was first reached from — a drainage tree toward the outlets. */
  readonly parent: Int32Array
  /** Cells in the order they were popped: outlets first, headwaters last. */
  readonly popOrder: Int32Array
  /** Inverse of popOrder: a smaller index means strictly closer to an outlet. */
  readonly popIndex: Int32Array
  /** Cells treated as open water, hence as outlets. */
  readonly ocean: Uint8Array
  readonly oceanCellCount: number
}

/**
 * Priority-Flood from the domain boundary (and from open water) inward.
 *
 * `oceanLevelMetres` marks cells at or below that level which connect to the
 * domain edge through equally low cells as open water: outlets, not
 * depressions. Without it a coastal DEM with bathymetry reports the sea floor
 * as the deepest flood on the map. An inland polder below sea level stays a
 * depression, because its ring of higher ground breaks the path.
 */
export const priorityFlood = (
  elevations: Float32Array,
  width: number,
  height: number,
  oceanLevelMetres?: number,
): FilledSurface => {
  const n = width * height
  if (elevations.length !== n) {
    throw new RangeError(`elevations holds ${elevations.length} cells, grid needs ${n}`)
  }

  const ocean = new Uint8Array(n)
  let oceanCellCount = 0
  if (oceanLevelMetres !== undefined) {
    const queue: number[] = []
    const enqueue = (i: number): void => {
      if (ocean[i] || !(elevations[i]! <= oceanLevelMetres)) return
      ocean[i] = 1
      oceanCellCount++
      queue.push(i)
    }
    for (let x = 0; x < width; x++) {
      enqueue(x)
      if (height > 1) enqueue((height - 1) * width + x)
    }
    for (let y = 1; y < height - 1; y++) {
      enqueue(y * width)
      if (width > 1) enqueue(y * width + width - 1)
    }
    while (queue.length > 0) {
      const c = queue.pop()!
      const cx = c % width
      const cy = (c - cx) / width
      for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        enqueue(ny * width + nx)
      }
    }
  }

  const filled = new Float64Array(n)
  const parent = new Int32Array(n).fill(-1)
  const visited = new Uint8Array(n)
  const popOrder = new Int32Array(n)
  const popIndex = new Int32Array(n).fill(-1)
  const heap = new MinHeap(n)

  const seed = (i: number): void => {
    if (visited[i]) return
    visited[i] = 1
    filled[i] = elevations[i]!
    heap.push(i, filled[i]!)
  }
  for (let x = 0; x < width; x++) {
    seed(x)
    if (height > 1) seed((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    seed(y * width)
    if (width > 1) seed(y * width + width - 1)
  }
  if (oceanCellCount > 0) {
    for (let i = 0; i < n; i++) if (ocean[i]) seed(i)
  }

  let popCount = 0
  while (heap.length > 0) {
    const c = heap.pop()
    popIndex[c] = popCount
    popOrder[popCount++] = c
    const cx = c % width
    const cy = (c - cx) / width
    for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const ni = ny * width + nx
      if (visited[ni]) continue
      visited[ni] = 1
      parent[ni] = c
      filled[ni] = Math.max(filled[c]!, elevations[ni]!)
      heap.push(ni, filled[ni]!)
    }
  }

  return { filled, parent, popOrder, popIndex, ocean, oceanCellCount }
}

export interface GridGeometry {
  readonly rowCellWidthM: Float64Array
  readonly rowCellHeightM: Float64Array
  readonly rowCellAreaM2: Float64Array
}

/**
 * D8 flow directions on the filled surface: each cell drains to its steepest
 * downslope neighbour.
 *
 * Candidates are restricted to neighbours that popped earlier in the
 * Priority-Flood sweep. That single rule does two jobs: it guarantees the
 * receiver is strictly closer to an outlet (so the flow graph is a DAG and
 * accumulation is a single pass in reverse pop order), and it resolves flats —
 * on a filled plateau every slope is zero, so the tie-break falls to the
 * earliest-popped neighbour, which is the way out.
 *
 * Returns -1 for outlets: boundary cells and open water.
 */
export const d8Receivers = (
  surface: FilledSurface,
  width: number,
  height: number,
  geometry: GridGeometry,
): Int32Array => {
  const n = width * height
  const receivers = new Int32Array(n).fill(-1)
  const { filled, popIndex } = surface

  for (let c = 0; c < n; c++) {
    const cx = c % width
    const cy = (c - cx) / width
    if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) continue
    if (surface.ocean[c]) continue

    const dxM = geometry.rowCellWidthM[cy]!
    const dyM = geometry.rowCellHeightM[cy]!
    const diagM = Math.hypot(dxM, dyM)

    let bestSlope = -Infinity
    let bestPop = Infinity
    let best = -1
    for (const [ox, oy, diagonal] of NEIGHBOUR_OFFSETS) {
      const nx = cx + ox
      const ny = cy + oy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const ni = ny * width + nx
      if (popIndex[ni]! >= popIndex[c]!) continue
      const dist = diagonal ? diagM : ox === 0 ? dyM : dxM
      const slope = (filled[c]! - filled[ni]!) / dist
      if (slope > bestSlope || (slope === bestSlope && popIndex[ni]! < bestPop)) {
        bestSlope = slope
        bestPop = popIndex[ni]!
        best = ni
      }
    }
    receivers[c] = best
  }
  return receivers
}

/**
 * Accumulates `weights` downstream along the D8 graph.
 *
 * One pass in reverse pop order: a cell's receiver always popped before it, so
 * by the time a cell is visited every contributor upstream of it has already
 * been added.
 */
export const flowAccumulate = (
  receivers: Int32Array,
  popOrder: Int32Array,
  weights: Float64Array,
): Float64Array => {
  const accumulated = Float64Array.from(weights)
  for (let k = popOrder.length - 1; k >= 0; k--) {
    const c = popOrder[k]!
    const r = receivers[c]!
    if (r >= 0) accumulated[r]! += accumulated[c]!
  }
  return accumulated
}

/**
 * Highest value of `values` anywhere upstream of each cell, itself included.
 *
 * Run over elevation this gives headwater relief, which is what turns a
 * catchment area into an average channel gradient. Kirpich wants the slope of
 * the whole main channel; the slope measured at the outlet is the slope of the
 * floodplain the river ends on, and using it can overstate a basin's response
 * time several-fold.
 */
export const flowAccumulateMax = (
  receivers: Int32Array,
  popOrder: Int32Array,
  values: Float64Array,
): Float64Array => {
  const out = Float64Array.from(values)
  for (let k = popOrder.length - 1; k >= 0; k--) {
    const c = popOrder[k]!
    const r = receivers[c]!
    if (r >= 0 && out[c]! > out[r]!) out[r] = out[c]!
  }
  return out
}

/** Cells whose upstream contributing area reaches the channel-initiation threshold. */
export const channelMask = (drainageAreaM2: Float64Array, thresholdM2: number): Uint8Array => {
  const mask = new Uint8Array(drainageAreaM2.length)
  for (let i = 0; i < drainageAreaM2.length; i++) {
    if (drainageAreaM2[i]! >= thresholdM2) mask[i] = 1
  }
  return mask
}

/**
 * Channel slope, measured over a reach rather than a single cell.
 *
 * A one-cell drop on a DEM whose vertical quantisation is a metre is mostly
 * quantisation noise, and Manning takes the square root of it — so a
 * single-cell slope makes conveyance swing wildly between neighbouring cells.
 * Averaging over `reachCells` downstream smooths that without flattening real
 * gradients. Never returns zero: a zero slope is an infinite-depth channel.
 */
export const downstreamSlope = (
  surface: FilledSurface,
  receivers: Int32Array,
  width: number,
  geometry: GridGeometry,
  reachCells = 10,
  minimumSlope = 1e-4,
): Float64Array => {
  const n = receivers.length
  const slopes = new Float64Array(n).fill(minimumSlope)
  const { filled } = surface

  for (let c = 0; c < n; c++) {
    let current = c
    let distance = 0
    for (let step = 0; step < reachCells; step++) {
      const r = receivers[current]!
      if (r < 0) break
      const cy = Math.floor(current / width)
      const dxM = geometry.rowCellWidthM[cy]!
      const dyM = geometry.rowCellHeightM[cy]!
      const rowDelta = Math.floor(r / width) - cy
      const colDelta = (r % width) - (current % width)
      distance += rowDelta !== 0 && colDelta !== 0 ? Math.hypot(dxM, dyM) : colDelta !== 0 ? dxM : dyM
      current = r
    }
    if (distance > 0) {
      const drop = filled[c]! - filled[current]!
      slopes[c] = Math.max(minimumSlope, drop / distance)
    }
  }
  return slopes
}

export interface DepressionLabels {
  /** Component id per cell, or -1 where the ground is already at its spill level. */
  readonly label: Int32Array
  /** Spill level of each component. */
  readonly spill: Float64Array
  readonly count: number
}

/**
 * Connected components of cells standing below their spill level.
 *
 * `filled` is propagated by exact copy during Priority-Flood, so every cell of
 * one ponded surface carries a bit-identical level and strict equality is the
 * right test for "same pool".
 */
export const labelDepressions = (
  surface: FilledSurface,
  elevations: Float32Array,
  width: number,
  height: number,
): DepressionLabels => {
  const n = width * height
  const label = new Int32Array(n).fill(-1)
  const spills: number[] = []
  const stack: number[] = []
  const { filled } = surface

  for (let i = 0; i < n; i++) {
    if (label[i] !== -1 || !(filled[i]! > elevations[i]!)) continue
    const comp = spills.length
    const spill = filled[i]!
    spills.push(spill)
    label[i] = comp
    stack.push(i)
    while (stack.length > 0) {
      const c = stack.pop()!
      const cx = c % width
      const cy = (c - cx) / width
      for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const ni = ny * width + nx
        if (label[ni] !== -1 || filled[ni] !== spill || !(filled[ni]! > elevations[ni]!)) continue
        label[ni] = comp
        stack.push(ni)
      }
    }
  }
  return { label, spill: Float64Array.from(spills), count: spills.length }
}

export interface BreachReport {
  readonly depressionsConsidered: number
  readonly depressionsBreached: number
  readonly cellsCarved: number
  readonly deepestBeforeMetres: number
  readonly deepestAfterMetres: number
  /**
   * The filled surface of the elevations as they now stand, carving included.
   * Handed back so the caller does not immediately recompute what this function
   * has just worked out — a Priority-Flood pass over a million cells is not
   * cheap, and a single request was doing five identical ones.
   */
  readonly surface: FilledSurface
}

/**
 * Carves an outlet through spurious dams, instead of filling behind them.
 *
 * At 60-90 m a DEM does not resolve a narrow gorge, so the valley above it
 * closes into a basin that never existed, and a fill-only model ponds water
 * there to the height of the surrounding ridges — the source of the 110 m
 * "floods" this model reported in mountain terrain.
 *
 * Least-cost breaching after Lindsay (2016), "Efficient hybrid breaching-filling
 * sink removal methods for digital elevation models", Hydrological Processes 30:
 * from each deep pit, search outward for the cheapest path to genuinely lower
 * ground, where cost is how much earth the path would have to cut. A path is
 * only accepted within `maxLengthCells`, which is what separates an unresolved
 * gorge a few cells thick from a real closed basin like a caldera — the latter
 * has no short way out and is left to fill, correctly.
 *
 * Mutates `elevations` and returns what it did.
 */
export const breachSpuriousDepressions = (
  elevations: Float32Array,
  width: number,
  height: number,
  options: { minDepthMetres?: number; maxLengthCells?: number; oceanLevelMetres?: number } = {},
): BreachReport => {
  const minDepth = options.minDepthMetres ?? 5
  const maxLength = options.maxLengthCells ?? 40
  const n = width * height

  const surface = priorityFlood(elevations, width, height, options.oceanLevelMetres)
  const { label, spill, count } = labelDepressions(surface, elevations, width, height)

  // Deepest cell of each depression, and how far it stands below its spill.
  const pit = new Int32Array(count).fill(-1)
  for (let i = 0; i < n; i++) {
    const d = label[i]!
    if (d < 0) continue
    if (pit[d] === -1 || elevations[i]! < elevations[pit[d]!]!) pit[d] = i
  }

  let deepestBefore = 0
  const candidates: Array<{ comp: number; depth: number }> = []
  for (let d = 0; d < count; d++) {
    if (pit[d] === -1) continue
    const depth = spill[d]! - elevations[pit[d]!]!
    if (depth > deepestBefore) deepestBefore = depth
    if (depth >= minDepth) candidates.push({ comp: d, depth })
  }
  // Deepest first: opening a large artifact basin often drains smaller ones with it.
  candidates.sort((a, b) => b.depth - a.depth)

  // Generation-stamped scratch, so each search resets in O(1) rather than O(n).
  const cost = new Float64Array(n)
  const steps = new Int32Array(n)
  const cameFrom = new Int32Array(n)
  const stamp = new Int32Array(n)
  const settled = new Int32Array(n)
  let generation = 0
  let breached = 0
  let carved = 0

  for (const { comp } of candidates) {
    const start = pit[comp]!
    const startElev = elevations[start]!
    generation++

    // A search is confined to a (2·maxLength+1)² window, which bounds the heap.
    const heap = new MinHeap(Math.min(n, (2 * maxLength + 1) ** 2 + 8))
    cost[start] = 0
    steps[start] = 0
    cameFrom[start] = -1
    stamp[start] = generation
    heap.push(start, 0)

    let outlet = -1
    while (heap.length > 0) {
      const c = heap.pop()
      if (settled[c] === generation) continue
      settled[c] = generation

      // Genuinely lower ground outside this depression: a real way out.
      if (elevations[c]! < startElev && label[c]! !== comp) {
        outlet = c
        break
      }
      if (steps[c]! >= maxLength) continue

      const cx = c % width
      const cy = (c - cx) / width
      for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const ni = ny * width + nx
        if (settled[ni] === generation) continue
        // Cost is the earth this step would have to cut through.
        const next = cost[c]! + Math.max(0, elevations[ni]! - startElev) + 1e-6
        if (stamp[ni] === generation && next >= cost[ni]!) continue
        stamp[ni] = generation
        cost[ni] = next
        steps[ni] = steps[c]! + 1
        cameFrom[ni] = c
        heap.push(ni, next)
      }
    }

    if (outlet < 0) continue

    const path: number[] = []
    for (let c = outlet; ; c = cameFrom[c]!) {
      path.push(c)
      if (c === start || cameFrom[c] === -1) break
    }
    if (path[path.length - 1] !== start || path.length < 3) continue
    path.reverse()

    // Carve a monotonic fall from the pit to the outlet, never raising ground.
    const outletElev = elevations[outlet]!
    const k = path.length - 1
    for (let i = 1; i < k; i++) {
      const target = startElev + ((outletElev - startElev) * i) / k
      if (target < elevations[path[i]!]!) {
        elevations[path[i]!] = target
        carved++
      }
    }
    breached++
  }

  // Carving changed the ground, so the filled surface has to be redone — but
  // only if anything was actually carved.
  let deepestAfter = deepestBefore
  let finalSurface = surface
  if (breached > 0) {
    finalSurface = priorityFlood(elevations, width, height, options.oceanLevelMetres)
    deepestAfter = 0
    for (let i = 0; i < n; i++) {
      const d = finalSurface.filled[i]! - elevations[i]!
      if (d > deepestAfter) deepestAfter = d
    }
  }

  return {
    depressionsConsidered: candidates.length,
    depressionsBreached: breached,
    cellsCarved: carved,
    deepestBeforeMetres: deepestBefore,
    deepestAfterMetres: deepestAfter,
    surface: finalSurface,
  }
}

export interface Inlet {
  /** Cell just outside the region, whose flow enters it. */
  readonly cell: number
  /** Upstream contributing area at that cell, m². */
  readonly areaM2: number
}

/**
 * Where channels cross into a region of interest from outside it.
 *
 * This is how a model of a finite window learns about the catchment upstream of
 * that window: a river entering the domain carries the runoff of everything
 * above it, which may be an order of magnitude more water than the domain
 * generates on its own.
 */
export const findInlets = (
  receivers: Int32Array,
  drainageAreaM2: Float64Array,
  isInside: (cell: number) => boolean,
  thresholdM2: number,
  maxPathSteps = 100_000,
): ReadonlyArray<Inlet> => {
  const candidates: Array<Inlet> = []
  for (let c = 0; c < receivers.length; c++) {
    if (isInside(c)) continue
    const r = receivers[c]!
    if (r < 0 || !isInside(r)) continue
    if (drainageAreaM2[c]! < thresholdM2) continue
    candidates.push({ cell: c, areaM2: drainageAreaM2[c]! })
  }
  // Largest catchment first, so the trunk of a river is the crossing that is
  // kept and its lesser re-entries are the ones discarded.
  candidates.sort((a, b) => b.areaM2 - a.areaM2)

  /**
   * A region of interest is a circle, and a meandering river crosses a circle
   * more than once — entering, leaving, and entering again. Every one of those
   * inward crossings looks like an inlet, but they all carry the same water,
   * and summing them inflates the upstream catchment several-fold.
   *
   * Two crossings belong to the same river exactly when one lies on the other's
   * downstream path, so each candidate is walked downstream and rejected if it
   * runs into an inlet already accepted. Genuinely separate tributaries never
   * pass through each other's boundary cell, so they both survive.
   */
  const accepted: Array<Inlet> = []
  const acceptedCells = new Set<number>()
  for (const candidate of candidates) {
    let c = candidate.cell
    let duplicate = false
    for (let steps = 0; steps < maxPathSteps; steps++) {
      const r = receivers[c]!
      if (r < 0) break
      if (acceptedCells.has(r)) {
        duplicate = true
        break
      }
      c = r
    }
    if (duplicate) continue
    accepted.push(candidate)
    acceptedCells.add(candidate.cell)
  }
  return accepted
}
