/**
 * Fluvial inundation by HAND and a synthetic rating curve.
 *
 * The fill-and-spill model in `spread.ts` answers a steady-state question:
 * where does water come to rest. That is the right question for pluvial
 * ponding, and the wrong one for a river in flood — in steady state a
 * floodplain with an outlet stores nothing, so a volume-conserving model can
 * only inundate closed basins. Real river floods inundate because the flood
 * wave is unsteady: the peak exceeds what the channel can carry and water
 * spreads sideways for a few hours.
 *
 * The standard way to map that without a time axis is HAND — Height Above
 * Nearest Drainage. Each cell is measured against the river cell it drains to,
 * a stage is derived for each reach from its discharge, and everything standing
 * below that stage is inundated. The stage comes from a rating curve built out
 * of the terrain itself: for a trial stage, the DEM gives the wetted volume and
 * plan area around the reach, which give a cross-section, and Manning turns
 * that into a discharge. No shape parameters are invented.
 *
 * References:
 *  - Nobre et al. (2011), "Height Above the Nearest Drainage — a hydrologically
 *    relevant new terrain model", Journal of Hydrology 404.
 *  - Zheng et al. (2018), "River Channel Geometry and Rating Curve Estimation
 *    Using Height Above the Nearest Drainage", JAWRA 54(4) — the synthetic
 *    rating curve this follows.
 *  - Operational use: NOAA/OWP Height Above Nearest Drainage Flood Inundation
 *    Mapping (HAND-FIM).
 */
import { manningDischargeM3PerS } from './channel'
import {
  applyHydraulicStageEffects,
  type HydraulicStageContext,
  type HydraulicStageSummary,
} from './dynamics'
import { flowAccumulate } from './flow'

export interface DrainageHeights {
  /** Metres above the river cell this cell drains to. Zero on the river itself. */
  readonly hand: Float32Array
  /** Index of that river cell, or -1 where nothing downstream is a channel. */
  readonly nearestChannel: Int32Array
}

/**
 * Height above nearest drainage, following each cell's flow path downstream to
 * the first channel it meets.
 *
 * One forward pass over the Priority-Flood pop order is enough: a cell's
 * receiver always popped before it, so the receiver's answer is already known.
 */
export const heightAboveDrainage = (
  elevations: Float32Array,
  receivers: Int32Array,
  popOrder: Int32Array,
  isChannel: Uint8Array,
): DrainageHeights => {
  const n = elevations.length
  const hand = new Float32Array(n)
  const nearestChannel = new Int32Array(n).fill(-1)

  for (let k = 0; k < popOrder.length; k++) {
    const c = popOrder[k]!
    if (isChannel[c]) {
      nearestChannel[c] = c
      hand[c] = 0
      continue
    }
    const r = receivers[c]!
    const inherited = r >= 0 ? nearestChannel[r]! : -1
    nearestChannel[c] = inherited
    // Clamped at zero: on a filled surface a cell can sit a hair below the
    // river it drains to, and a negative height above drainage is meaningless.
    hand[c] = inherited >= 0 ? Math.max(0, elevations[c]! - elevations[inherited]!) : 0
  }
  return { hand, nearestChannel }
}

/** Trial stages for the rating curve, metres above the river. */
const STAGE_LADDER: ReadonlyArray<number> = [
  0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20,
]

/**
 * Which discharge the rating curve is solved for.
 *
 * `excess` is the physical reading of a confined channel: it carries its
 * defended discharge and only the surplus spreads sideways, so extent grows
 * continuously from the moment the defences are exceeded. `total` is the
 * competing reading — once a levee is overtopped the whole flow shares one
 * water surface — and is a step change at the defended capacity. Both are
 * defensible; `total` is retained so the two can be measured against each
 * other.
 */
export type StageDischarge = 'total' | 'excess'

export interface FluvialInput {
  readonly hand: Float32Array
  readonly nearestChannel: Int32Array
  readonly isChannel: Uint8Array
  /** Discharge routed past each channel cell, m³/s. */
  readonly dischargeM3PerS: Float64Array
  readonly slope: Float64Array
  readonly rowCellAreaM2: Float64Array
  /** Along-flow length represented by one cell, metres. */
  readonly reachLengthM: number
  readonly width: number
  readonly height: number
  readonly roughness: number
  /**
   * Manning's n for the part of the section outside the channel.
   *
   * The rating curve otherwise runs one roughness across the whole flooded
   * width, and the channel value (0.035, a clean stream) is far too smooth for
   * a floodplain that is vegetated, built up or fenced — Chow (1959) table 5-6
   * puts those at 0.05-0.12. Too smooth a floodplain conveys too much, so the
   * curve is satisfied at too low a stage, and it is worst exactly where the top
   * width is kilometres and the error is largest.
   *
   * Supplying it makes the section compound; `compoundMethod` decides how the
   * two roughnesses are combined. Omitting it keeps the single-section form,
   * which is what every published figure for this model was measured with.
   */
  readonly floodplainRoughness?: number
  /** How to combine the two roughnesses. Default `composite`. */
  readonly compoundMethod?: CompoundMethod
  /**
   * Discharge each reach is defended to, m³/s. A managed river does not
   * inundate its floodplain the moment it passes bankfull — bankfull is roughly
   * a one-to-two-year flow, and embankments hold far more. Below this the
   * floodplain stays dry. Omit to assume no defence anywhere.
   */
  readonly defendedCapacityM3PerS?: Float64Array
  /** Discharge the rating curve is solved for. Default `total`. */
  readonly stageDischarge?: StageDischarge
  /**
   * Diagnostic: give every active reach this stage and skip the rating curve
   * entirely.
   *
   * It exists to bound the method rather than to model anything. Sweeping it
   * answers "what is the best extent HAND on this terrain could produce if the
   * stage were chosen perfectly", which is the ceiling every rating-curve
   * improvement is working under. Never a modelling option — a real river does
   * not stand at one height over a whole basin.
   */
  readonly uniformStageM?: number
  /**
   * Hold each reach's stage down to the water the river actually delivered.
   * Requires `receivers`, `popOrder` and `durationSeconds`. The budget behind
   * the constraint is evaluated and reported whenever those are supplied; this
   * flag decides only whether it is allowed to move the stage.
   */
  readonly volumeConstraint?: boolean
  /**
   * Window over which the solved stage is averaged along the channel, metres.
   *
   * Each reach solves its rating curve from only the strip of cells that
   * happen to drain to it, so adjacent reaches on one river can stand metres
   * apart — per-reach noise, not hydraulics, and the reason a constant stage
   * chosen with hindsight beats the solved field at three of the four hindcast
   * sites. A real water surface is smooth over kilometres (gradually varied
   * flow), so the stage gets the treatment `downstreamSlope` already gives the
   * slope for the same reason: average it over a reach of river.
   *
   * A pegged reach is excluded as a source — its ladder-top stage is a failure
   * marker, not information — but participates as a target, so a lone pegged
   * reach among solved neighbours takes their consensus instead of 20 m. A
   * pegged cluster with no solved neighbour in reach keeps the peg.
   *
   * 0 disables. Needs `receivers`.
   */
  readonly stageSmoothingM?: number
  /** D8 receivers, for accumulating storage along the drainage network. */
  readonly receivers?: Int32Array
  /** Priority-Flood pop order, receivers before their donors. */
  readonly popOrder?: Int32Array
  /** Event duration, for turning an excess discharge into an overbank volume. */
  readonly durationSeconds?: number
  /**
   * Actual routed event volume above the defended capacity. When supplied this
   * keeps the storage budget volume-conserving even though `dischargeM3PerS`
   * is the short-lived hydrograph peak rather than an event average.
   */
  readonly overbankVolumeM3?: Float64Array
  /** Optional arrival, momentum and backwater correction applied before the volume budget. */
  readonly hydraulicEffects?: HydraulicStageContext
}

/**
 * Why the available-volume check did or did not bind.
 *
 * A safeguard that never fires is indistinguishable from one that is not there,
 * so the budget is evaluated and reported whether or not it was allowed to act.
 */
export interface VolumeBudget {
  /** Floodplain storage the mapped stages imply across the whole window, m³. */
  readonly mappedStorageM3: number
  /** Overbank volume delivered past the main stem, m³. */
  readonly trunkOverbankVolumeM3: number
  /** Storage accumulated above the main stem, m³ — what that volume is asked to fill. */
  readonly trunkCumulativeStorageM3: number
  /** Tightest supportable share anywhere; 1 means the water was always there. */
  readonly minimumSupportedShare: number
  /** Reaches mapped above what the water delivered, whether or not it was acted on. */
  readonly reachesOverBudget: number
}

export interface FluvialResult {
  /** Inundation depth from river flooding, metres, row-major. */
  readonly depths: Float32Array
  /** Stage reached at each channel cell, metres above the river. */
  readonly stageM: Float64Array
  readonly wetCells: number
  readonly maxStageM: number
  /** Reaches whose discharge exceeded the whole ladder: stage pegged, not solved. */
  readonly peggedReaches: number
  /**
   * 1 at each channel cell whose stage the ladder could not solve. Water mapped
   * from a pegged reach is a failure mode of the rating curve rather than a
   * solution of it, and attributing extent to that failure needs the mask, not
   * just the count — `peggedReaches` is this array's sum.
   */
  readonly pegged: Uint8Array
  /** Reaches actually held below their rating-curve stage. Zero when the constraint is off. */
  readonly volumeLimitedReaches: number
  /** Reaches left dry because their defences were not overtopped. */
  readonly defendedReaches: number
  /** Null when the network needed to accumulate storage was not supplied. */
  readonly volumeBudget: VolumeBudget | null
  /** Null for the legacy steady-stage path and the uniform-stage diagnostic. */
  readonly hydraulics: HydraulicStageSummary | null
}

/** Stage at which the strip storage curve passes `target`, between two known points. */
const interpolateStage = (
  lowStage: number, lowVolume: number,
  highStage: number, highVolume: number,
  target: number,
): number => {
  if (!(highVolume > lowVolume)) return lowStage
  const fraction = (target - lowVolume) / (highVolume - lowVolume)
  return lowStage + (highStage - lowStage) * Math.min(1, Math.max(0, fraction))
}

/**
 * How the channel's roughness and its floodplain's are combined.
 *
 * They are not two spellings of one idea and they disagree most on exactly the
 * wide shallow sections that dominate here:
 *
 * - `composite` keeps one section and blends the roughness over the wetted
 *   perimeter (Horton 1933; Einstein 1934). Conveyance changes only because the
 *   roughness did.
 * - `divided` gives the channel and the floodplain their own conveyance and
 *   sums them (Chow 1959 §6). Splitting raises total conveyance on its own —
 *   the channel sub-section has a far larger hydraulic radius than the section
 *   average — so it *lowers* the solved stage even at unchanged roughness, and
 *   the two effects fight each other.
 *
 * Which is right here is not decidable from first principles, because the DEM
 * does not resolve the channel: a "channel" cell is one 60-90 m cell of
 * floodplain-level ground, so the deep efficient sub-section `divided` credits
 * is not one the terrain actually shows.
 */
export type CompoundMethod = 'composite' | 'divided'

/**
 * One roughness for a section made of two, weighted over the wetted perimeter
 * (Horton 1933; Einstein 1934):
 *
 *     n = [ Σ (P_i · n_i^1.5) / P ] ^ (2/3)
 *
 * On a section kilometres wide against metres deep the perimeter of each part
 * is its top width to well within the error of everything around it.
 */
const compositeRoughness = (
  channelTopWidthM: number,
  topWidthM: number,
  channelRoughness: number,
  floodplainRoughness: number,
): number => {
  const floodplainWidthM = Math.max(0, topWidthM - channelTopWidthM)
  const perimeter = channelTopWidthM + floodplainWidthM
  if (perimeter <= 0) return channelRoughness
  const weighted =
    (channelTopWidthM * channelRoughness ** 1.5 + floodplainWidthM * floodplainRoughness ** 1.5) /
    perimeter
  return weighted ** (2 / 3)
}

/**
 * Discharge of a compound section, by the divided channel method.
 *
 * The channel and its floodplain are treated as two sub-sections, each carrying
 * what its own roughness allows, and the two are summed. It is the standard
 * reading of an out-of-bank section (Chow 1959 §6; the method HEC-RAS applies
 * when a cross-section is given overbank n values), and it matters here because
 * the two roughnesses differ by a factor of two to four and the floodplain is
 * most of the width.
 *
 * The interface between the sub-sections is deliberately not counted as wetted
 * perimeter, as in the standard method — on a section kilometres wide against
 * metres deep it would change nothing anyway.
 */
const compoundDischargeM3PerS = (input: {
  readonly crossSectionM2: number
  readonly topWidthM: number
  readonly channelCrossSectionM2: number
  readonly channelTopWidthM: number
  readonly slope: number
  readonly roughness: number
  readonly floodplainRoughness: number
}): number => {
  const { crossSectionM2, topWidthM, channelCrossSectionM2, channelTopWidthM } = input
  const floodplainCrossSectionM2 = Math.max(0, crossSectionM2 - channelCrossSectionM2)
  const floodplainTopWidthM = Math.max(0, topWidthM - channelTopWidthM)

  const channel =
    channelTopWidthM > 0
      ? manningDischargeM3PerS(
          channelTopWidthM,
          channelCrossSectionM2 / channelTopWidthM,
          input.slope,
          input.roughness,
        )
      : 0
  const floodplain =
    floodplainTopWidthM > 0
      ? manningDischargeM3PerS(
          floodplainTopWidthM,
          floodplainCrossSectionM2 / floodplainTopWidthM,
          input.slope,
          input.floodplainRoughness,
        )
      : 0
  return channel + floodplain
}

/**
 * Inundation depth from river stage.
 *
 * For each trial stage the terrain around every reach gives a wetted volume and
 * plan area; dividing by the reach length turns those into a cross-sectional
 * area and a top width, and Manning turns those into the discharge that stage
 * could carry. The stage actually assigned to a reach is the lowest one whose
 * discharge covers what is routed past it, interpolated between ladder steps.
 */
export const fluvialInundation = (input: FluvialInput): FluvialResult => {
  const {
    hand, nearestChannel, isChannel, dischargeM3PerS, slope,
    rowCellAreaM2, reachLengthM, width, height, roughness,
    defendedCapacityM3PerS, stageDischarge = 'total',
    volumeConstraint = false, receivers, popOrder, durationSeconds,
    uniformStageM, floodplainRoughness, compoundMethod = 'composite',
    stageSmoothingM = 0, overbankVolumeM3: suppliedOverbankVolumeM3,
    hydraulicEffects,
  } = input
  if (stageSmoothingM > 0 && receivers === undefined) {
    throw new TypeError('stage smoothing needs receivers to know which reach is downstream of which')
  }
  const n = width * height
  const stageM = new Float64Array(n)
  const resolved = new Uint8Array(n)
  const active = new Uint8Array(n)
  /** What the rating curve is asked to pass, m³/s. */
  const solveDischargeM3PerS = new Float64Array(n)

  const canBudget = receivers !== undefined && popOrder !== undefined && durationSeconds! > 0
  if (volumeConstraint && !canBudget) {
    throw new TypeError(
      'the cumulative volume constraint needs receivers, popOrder and a positive durationSeconds',
    )
  }
  if (suppliedOverbankVolumeM3 !== undefined && suppliedOverbankVolumeM3.length !== n) {
    throw new RangeError(
      `overbankVolumeM3 holds ${suppliedOverbankVolumeM3.length} cells, grid needs ${n}`,
    )
  }

  let defendedReaches = 0
  for (let c = 0; c < n; c++) {
    if (!isChannel[c]) continue
    const q = dischargeM3PerS[c]!
    if (!(q > 0)) continue
    const defended = defendedCapacityM3PerS ? defendedCapacityM3PerS[c]! : 0
    // A confined channel carries its defended discharge; in `excess` only the
    // surplus reaches the floodplain, in `total` the whole flow does once the
    // defences fail. Either way a reach within its defences stays dry.
    const solve = stageDischarge === 'excess' ? q - defended : q
    if (defended > 0 && q <= defended) {
      defendedReaches++
      continue
    }
    if (!(solve > 0)) continue
    solveDischargeM3PerS[c] = solve
    active[c] = 1
  }

  if (uniformStageM !== undefined) {
    for (let c = 0; c < n; c++) {
      if (!active[c]) continue
      stageM[c] = uniformStageM
      resolved[c] = 1
    }
  }

  // Rating curve, one ladder step at a time: each step accumulates the wetted
  // volume and plan area every reach would have at that stage.
  const volume = new Float64Array(n)
  const planArea = new Float64Array(n)
  /**
   * The same two totals over the channel cell alone, kept only for the divided
   * channel method. A reach's own cell is the only channel cell that drains to
   * it, so this is the widest the DEM can resolve the channel as being.
   */
  const compound = floodplainRoughness !== undefined
  const channelVolume = compound ? new Float64Array(n) : null
  const channelPlanArea = compound ? new Float64Array(n) : null
  let previousStage = 0

  for (const stage of STAGE_LADDER) {
    volume.fill(0)
    planArea.fill(0)
    channelVolume?.fill(0)
    channelPlanArea?.fill(0)
    for (let i = 0; i < n; i++) {
      const target = nearestChannel[i]!
      if (target < 0 || !active[target] || resolved[target]) continue
      const h = hand[i]!
      if (h > stage) continue
      const cellArea = rowCellAreaM2[Math.floor(i / width)]!
      volume[target]! += (stage - h) * cellArea
      planArea[target]! += cellArea
      if (compound && isChannel[i]) {
        channelVolume![target]! += (stage - h) * cellArea
        channelPlanArea![target]! += cellArea
      }
    }

    for (let c = 0; c < n; c++) {
      if (!active[c] || resolved[c]) continue
      const crossSectionM2 = volume[c]! / reachLengthM
      const topWidthM = planArea[c]! / reachLengthM
      if (crossSectionM2 <= 0 || topWidthM <= 0) continue
      const meanDepthM = crossSectionM2 / topWidthM
      const channelTopWidthM = compound ? channelPlanArea![c]! / reachLengthM : 0
      const capacity = !compound
        ? manningDischargeM3PerS(topWidthM, meanDepthM, slope[c]!, roughness)
        : compoundMethod === 'divided'
          ? compoundDischargeM3PerS({
              crossSectionM2,
              topWidthM,
              channelCrossSectionM2: channelVolume![c]! / reachLengthM,
              channelTopWidthM,
              slope: slope[c]!,
              roughness,
              floodplainRoughness: floodplainRoughness!,
            })
          : manningDischargeM3PerS(
              topWidthM,
              meanDepthM,
              slope[c]!,
              compositeRoughness(channelTopWidthM, topWidthM, roughness, floodplainRoughness!),
            )
      if (capacity >= solveDischargeM3PerS[c]!) {
        // Linear interpolation inside the step it was crossed in.
        stageM[c] = previousStage + (stage - previousStage) * 0.5
        resolved[c] = 1
      }
    }
    previousStage = stage
  }

  // A reach the ladder never satisfied is carrying more than 20 m of stage
  // could pass; peg it at the top rather than pretending it is dry, and say so.
  const topStage = STAGE_LADDER[STAGE_LADDER.length - 1]!
  const pegged = new Uint8Array(n)
  let peggedReaches = 0
  for (let c = 0; c < n; c++) {
    if (!active[c] || resolved[c]) continue
    stageM[c] = topStage
    pegged[c] = 1
    peggedReaches++
  }

  if (stageSmoothingM > 0 && uniformStageM === undefined) {
    smoothStageAlongChannel({
      stageM, active, pegged, isChannel, receivers: receivers!, reachLengthM, stageSmoothingM,
    })
  }

  const hydraulic = hydraulicEffects === undefined
    ? null
    : applyHydraulicStageEffects({
        stageM,
        hand,
        nearestChannel,
        isChannel,
        rowCellAreaM2,
        reachLengthM,
        width,
        height,
        invalidControl: pegged,
        context: hydraulicEffects,
      })
  if (hydraulic !== null) stageM.set(hydraulic.stageM)

  const constraint = canBudget
    ? applyVolumeConstraint({
        stageM, active, hand, nearestChannel, rowCellAreaM2, width, n,
        receivers: receivers!, popOrder: popOrder!,
        overbankVolumeM3: suppliedOverbankVolumeM3 ?? overbankVolume(
          n, isChannel, dischargeM3PerS, defendedCapacityM3PerS, durationSeconds!,
        ),
        apply: volumeConstraint,
      })
    : null

  const depths = new Float32Array(n)
  let wetCells = 0
  let maxStageM = 0
  for (let i = 0; i < n; i++) {
    const target = nearestChannel[i]!
    if (target < 0) continue
    const stage = stageM[target]!
    if (stage > maxStageM) maxStageM = stage
    const depth = stage - hand[i]!
    if (depth > 0) {
      depths[i] = depth
      wetCells++
    }
  }

  return {
    depths, stageM, wetCells, maxStageM, peggedReaches, pegged, defendedReaches,
    volumeLimitedReaches: constraint?.limitedReaches ?? 0,
    volumeBudget: constraint?.budget ?? null,
    hydraulics: hydraulic?.summary ?? null,
  }
}

/** Volume that went past each reach above what its defences could carry, m³. */
const overbankVolume = (
  n: number,
  isChannel: Uint8Array,
  dischargeM3PerS: Float64Array,
  defendedCapacityM3PerS: Float64Array | undefined,
  durationSeconds: number,
): Float64Array => {
  const out = new Float64Array(n)
  for (let c = 0; c < n; c++) {
    if (!isChannel[c]) continue
    const defended = defendedCapacityM3PerS ? defendedCapacityM3PerS[c]! : 0
    out[c] = Math.max(0, dischargeM3PerS[c]! - defended) * durationSeconds
  }
  return out
}

interface VolumeConstraintInput {
  readonly stageM: Float64Array
  readonly active: Uint8Array
  readonly hand: Float32Array
  readonly nearestChannel: Int32Array
  readonly rowCellAreaM2: Float64Array
  readonly width: number
  readonly n: number
  readonly receivers: Int32Array
  readonly popOrder: Int32Array
  readonly overbankVolumeM3: Float64Array
  /** False evaluates the budget and reports it without touching the stage. */
  readonly apply: boolean
}

/**
 * Holds the mapped water surface down to the water the river actually delivered,
 * mutating `stageM` in place and returning how many reaches it moved.
 *
 * HAND maps a stage without asking whether enough water exists to hold it, and
 * on a wide flat valley it will happily map more than the river ever brought
 * past. The test has to be cumulative to mean anything: a single reach's strip
 * is one cell of river length while the overbank volume passing it is the whole
 * upstream river's, so comparing the two is loose by the ratio of river length
 * to cell length — three or four orders of magnitude, which is why the per-cell
 * form this replaced never once fired.
 *
 * At the scale the physics is actually at:
 *
 *   S(c)     strip storage implied by the stage assigned to reach c
 *   cumS(c)  that storage accumulated over everything draining to c
 *   O(c)     overbank volume delivered past c
 *   f(c)     min(1, O(c)/cumS(c)) — the share of the mapped storage water exists for
 *   limit(u) min(f(u), limit(receiver(u)))
 *
 * `limit` carries the tightest downstream constraint back upstream, which is the
 * right direction: if the budget fails at c, everything draining to c
 * collectively overspent. A limited reach is then re-read back down its own
 * rating curve to the stage its share of the storage corresponds to.
 *
 * One pass, deliberately: lowering stages upstream relaxes the constraint
 * downstream, so this is conservative rather than exact.
 */
/**
 * Averages each reach's stage with the reaches within half a window of it along
 * the channel, walking downstream from every reach as `downstreamSlope` does.
 * Each downstream pair inside the window contributes symmetrically, so a
 * confluence hears its tributaries and they hear it. Mutates `stageM` in place.
 */
const smoothStageAlongChannel = (input: {
  readonly stageM: Float64Array
  readonly active: Uint8Array
  readonly pegged: Uint8Array
  readonly isChannel: Uint8Array
  readonly receivers: Int32Array
  readonly reachLengthM: number
  readonly stageSmoothingM: number
}): void => {
  const { stageM, active, pegged, isChannel, receivers, reachLengthM, stageSmoothingM } = input
  const n = stageM.length
  const halfWindowCells = Math.max(1, Math.round(stageSmoothingM / 2 / reachLengthM))
  const sum = new Float64Array(n)
  const count = new Int32Array(n)

  for (let c = 0; c < n; c++) {
    if (!isChannel[c] || !active[c]) continue
    let d = c
    for (let step = 0; step < halfWindowCells; step++) {
      d = receivers[d]!
      if (d < 0 || !isChannel[d] || !active[d]) break
      // Pegged stages are markers, not measurements: they are never lent out,
      // but both ends still receive, so a pegged reach can be re-estimated.
      if (!pegged[d]) {
        sum[c]! += stageM[d]!
        count[c]!++
      }
      if (!pegged[c]) {
        sum[d]! += stageM[c]!
        count[d]!++
      }
    }
  }

  for (let c = 0; c < n; c++) {
    if (!isChannel[c] || !active[c] || count[c] === 0) continue
    const own = pegged[c] ? 0 : stageM[c]!
    const weight = pegged[c] ? count[c]! : count[c]! + 1
    stageM[c] = (sum[c]! + own) / weight
  }
}

const applyVolumeConstraint = (
  input: VolumeConstraintInput,
): { limitedReaches: number; budget: VolumeBudget } => {
  const {
    stageM, active, hand, nearestChannel, rowCellAreaM2, width, n,
    receivers, popOrder, overbankVolumeM3, apply,
  } = input

  // S(c): storage the assigned stage implies for each reach's own strip.
  const storageM3 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const target = nearestChannel[i]!
    if (target < 0 || !active[target]) continue
    const depth = stageM[target]! - hand[i]!
    if (depth <= 0) continue
    storageM3[target]! += depth * rowCellAreaM2[Math.floor(i / width)]!
  }

  const cumulativeStorageM3 = flowAccumulate(receivers, popOrder, storageM3)

  // The main stem, for reporting: the out-of-bank reach the most storage drains
  // to. Restricted to those reaches deliberately — the largest cumulative
  // storage of all sits on whatever cell the network drains out through, which
  // need not be a channel and would report an overbank volume of zero.
  let trunk = -1
  let mappedStorageM3 = 0
  for (let c = 0; c < n; c++) {
    mappedStorageM3 += storageM3[c]!
    if (!active[c]) continue
    if (trunk < 0 || cumulativeStorageM3[c]! > cumulativeStorageM3[trunk]!) trunk = c
  }

  // limit(u) = min(f(u), limit(receiver(u))), one forward pass: a cell's
  // receiver always pops before it, so the downstream answer is already known.
  //
  // Only a reach that is itself out of bank imposes its own share. A reach
  // still inside its defences has no overbank volume, and letting that zero
  // propagate would dry out every floodplain above it — water that left the
  // channel upstream never had to pass this reach out of bank to get there.
  const limit = new Float64Array(n).fill(1)
  let minimumSupportedShare = 1
  for (let k = 0; k < popOrder.length; k++) {
    const c = popOrder[k]!
    const cumulative = cumulativeStorageM3[c]!
    let own = 1
    if (active[c] && cumulative > 0) own = Math.min(1, overbankVolumeM3[c]! / cumulative)
    if (own < minimumSupportedShare) minimumSupportedShare = own
    const r = receivers[c]!
    limit[c] = r >= 0 ? Math.min(own, limit[r]!) : own
  }

  const summarise = (reachesOverBudget: number): VolumeBudget => ({
    mappedStorageM3,
    trunkOverbankVolumeM3: trunk >= 0 ? overbankVolumeM3[trunk]! : 0,
    trunkCumulativeStorageM3: trunk >= 0 ? cumulativeStorageM3[trunk]! : 0,
    minimumSupportedShare,
    reachesOverBudget,
  })

  // Reaches the budget cannot pay for in full, and the storage they may keep.
  const targetStorageM3 = new Float64Array(n)
  const constrained = new Uint8Array(n)
  let limitedCount = 0
  for (let c = 0; c < n; c++) {
    if (!active[c] || limit[c]! >= 1 || storageM3[c]! <= 0) continue
    constrained[c] = 1
    targetStorageM3[c] = limit[c]! * storageM3[c]!
    limitedCount++
  }
  const budget = summarise(limitedCount)
  if (limitedCount === 0 || !apply) return { limitedReaches: 0, budget }

  // Read each constrained reach back down its own rating curve: the ladder step
  // whose strip storage brackets the target, interpolated. The curve is
  // monotonic in stage and the target is at most the storage already assigned,
  // so the crossing always lies at or below the assigned stage.
  const settled = new Uint8Array(n)
  const lowStage = new Float64Array(n)
  const lowVolume = new Float64Array(n)
  const trialVolume = new Float64Array(n)

  for (const stage of STAGE_LADDER) {
    trialVolume.fill(0)
    for (let i = 0; i < n; i++) {
      const target = nearestChannel[i]!
      if (target < 0 || !constrained[target] || settled[target]) continue
      const h = hand[i]!
      if (h > stage) continue
      trialVolume[target]! += (stage - h) * rowCellAreaM2[Math.floor(i / width)]!
    }
    for (let c = 0; c < n; c++) {
      if (!constrained[c] || settled[c]) continue
      if (stage >= stageM[c]!) {
        stageM[c] = interpolateStage(
          lowStage[c]!, lowVolume[c]!, stageM[c]!, storageM3[c]!, targetStorageM3[c]!,
        )
        settled[c] = 1
        continue
      }
      const v = trialVolume[c]!
      if (v <= targetStorageM3[c]!) {
        lowStage[c] = stage
        lowVolume[c] = v
      } else {
        stageM[c] = interpolateStage(lowStage[c]!, lowVolume[c]!, stage, v, targetStorageM3[c]!)
        settled[c] = 1
      }
    }
  }
  // A reach whose assigned stage sits above the whole ladder (pegged at 20 m).
  for (let c = 0; c < n; c++) {
    if (!constrained[c] || settled[c]) continue
    stageM[c] = interpolateStage(
      lowStage[c]!, lowVolume[c]!, stageM[c]!, storageM3[c]!, targetStorageM3[c]!,
    )
  }
  return { limitedReaches: limitedCount, budget }
}

/** Element-wise maximum: two inundation mechanisms, not two bodies of water. */
export const combineDepths = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Math.max(a[i]!, b[i]!)
  return out
}
